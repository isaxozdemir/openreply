/**
 * Rate Limiter
 *
 * Redis-based rate limiter for Instagram private replies.
 *
 * The cap matches Meta's documented limit for this exact call: 750 private
 * replies per hour per Instagram professional account, for comments on posts
 * and reels. Exceeding it risks 429s and app-level restrictions, so the worker
 * requeues rather than pushing through.
 * https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
 *
 * Note this is a hard ceiling with no headroom. If Meta throttles before the
 * documented limit, or other calls on the same account share the bucket, lower
 * it with DM_RATE_LIMIT_MAX.
 *
 * 750 is what the API permits, not what is necessarily wise. Practitioner
 * guidance for comment-to-DM automation converges on roughly 200/hour, on the
 * grounds that a burst is what draws attention to an account even when every
 * individual call is inside the documented cap. A viral post is exactly when
 * both facts apply at once, so the ceiling is configurable and the queue
 * requeues rather than dropping anything when it is reached.
 */

import Redis from "ioredis";

const RATE_LIMIT_MAX = Number(
  process.env.DM_RATE_LIMIT_MAX ?? 750
); // private replies per hour; Meta documents 750
const RATE_LIMIT_WINDOW = 3600; // 1 hour in seconds
// How long a job waits before trying for a slot again. The window is a rolling
// hour, so slots free up continuously rather than all at once — waiting half an
// hour to retry leaves capacity idle while a backlog sits behind it. Ten
// minutes keeps the queue moving without hammering Redis.
const REQUEUE_DELAY_MS = Number(
  process.env.DM_REQUEUE_DELAY_MS ?? 10 * 60 * 1000
);
// How many times a job waits for a free slot before it is dropped.
//
// This is the drain budget, and it has to be read against the send rate. At
// 3 attempts × 30 minutes a job gives up after 1.5 hours; at 200 sends/hour
// that covers ~300 people, so a post drawing 2400 comments would have most of
// them discarded while still well inside Instagram's 7-day private-reply
// window. Twelve attempts covers a full 6 hours of backlog, which drains 2400
// at 200/hour with room to spare — and costs nothing when there is no backlog,
// since a job that gets a slot never requeues at all.
const MAX_REQUEUE_ATTEMPTS = Number(process.env.DM_MAX_REQUEUE_ATTEMPTS ?? 12);

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null, // required by BullMQ
    });
  }
  return redis;
}

export interface RateLimitResult {
  allowed: boolean;
  currentCount: number;
  remainingDMs: number;
  shouldRequeue: boolean;
  requeueDelayMs: number;
  shouldSkip: boolean;
  reserved: boolean;
}

const RESERVE_DM_SLOT_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
local max = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])

if current >= max then
  return {0, current, 0}
end

local next_count = redis.call("INCR", KEYS[1])
if next_count == 1 then
  redis.call("EXPIRE", KEYS[1], ttl)
end

return {1, next_count, max - next_count}
`;

function toScriptNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseInt(value, 10);
  return 0;
}

function blockedResult(
  count: number,
  requeueAttempt: number
): RateLimitResult {
  if (requeueAttempt >= MAX_REQUEUE_ATTEMPTS) {
    return {
      allowed: false,
      currentCount: count,
      remainingDMs: 0,
      shouldRequeue: false,
      requeueDelayMs: 0,
      shouldSkip: true,
      reserved: false,
    };
  }

  return {
    allowed: false,
    currentCount: count,
    remainingDMs: 0,
    shouldRequeue: true,
    requeueDelayMs: REQUEUE_DELAY_MS,
    shouldSkip: false,
    reserved: false,
  };
}

/**
 * Check if an Instagram account is within its DM rate limit.
 *
 * Uses a Redis counter with a 1-hour TTL per account.
 * Key pattern: `rate:dm:{instagramAccountId}`
 *
 * @param instagramAccountId - The Instagram account ID to check
 * @param requeueAttempt - How many times this job has been requeued (0 = first attempt)
 * @returns Rate limit result with action recommendations
 */
export async function checkRateLimit(
  instagramAccountId: string,
  requeueAttempt: number = 0
): Promise<RateLimitResult> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;

  const currentCount = await client.get(key);
  const count = currentCount ? parseInt(currentCount, 10) : 0;

  if (count >= RATE_LIMIT_MAX) {
    // Over the limit
    if (requeueAttempt >= MAX_REQUEUE_ATTEMPTS) {
      // Exceeded max requeue attempts — skip this DM
      return {
        allowed: false,
        currentCount: count,
        remainingDMs: 0,
        shouldRequeue: false,
        requeueDelayMs: 0,
        shouldSkip: true,
        reserved: false,
      };
    }

    return {
      allowed: false,
      currentCount: count,
      remainingDMs: 0,
      shouldRequeue: true,
      requeueDelayMs: REQUEUE_DELAY_MS,
      shouldSkip: false,
      reserved: false,
    };
  }

  return {
    allowed: true,
    currentCount: count,
    remainingDMs: RATE_LIMIT_MAX - count,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: false,
  };
}

/**
 * Atomically reserve a DM send slot for an Instagram account.
 * This is the worker-safe path; it prevents concurrent jobs from all passing
 * the rate-limit check before any of them increments the Redis counter.
 */
export async function reserveDMSlot(
  instagramAccountId: string,
  requeueAttempt: number = 0
): Promise<RateLimitResult> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;

  const result = await client.eval(
    RESERVE_DM_SLOT_SCRIPT,
    1,
    key,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW
  );
  const values = Array.isArray(result) ? result : [];
  const allowedFlag = toScriptNumber(values[0]);
  const count = toScriptNumber(values[1]);
  const remaining = toScriptNumber(values[2]);

  if (allowedFlag !== 1) {
    return blockedResult(count, requeueAttempt);
  }

  return {
    allowed: true,
    currentCount: count,
    remainingDMs: remaining,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: true,
  };
}

/**
 * Backwards-compatible helper for tests and admin scripts.
 * Prefer reserveDMSlot in workers.
 */
export async function incrementDMCounter(
  instagramAccountId: string
): Promise<number> {
  const result = await reserveDMSlot(instagramAccountId, MAX_REQUEUE_ATTEMPTS);
  return result.currentCount;
}

/**
 * Get the current DM count for an Instagram account.
 */
export async function getCurrentDMCount(
  instagramAccountId: string
): Promise<number> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;
  const count = await client.get(key);
  return count ? parseInt(count, 10) : 0;
}

/**
 * Reset the rate limiter for an account (useful for testing).
 */
export async function resetRateLimit(
  instagramAccountId: string
): Promise<void> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;
  await client.del(key);
}

// Export constants for use in tests
export { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW, REQUEUE_DELAY_MS, MAX_REQUEUE_ATTEMPTS };

/**
 * Return a previously reserved DM slot to the hourly bucket.
 *
 * Called when a send fails after the slot was reserved. Without this, a failed
 * job permanently consumes quota: a comment retried three times burns three of
 * the 750 slots while delivering nothing, so the account hits the cap at a
 * fraction of its real capacity.
 *
 * Floors at zero and never creates the key — if the hour rolled over and the
 * counter expired, there is nothing to give back and we must not resurrect a
 * stale bucket without a TTL.
 */
const RELEASE_DM_SLOT_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1]) or "-1")
if current <= 0 then
  return 0
end
return redis.call("DECR", KEYS[1])
`;

export async function releaseDMSlot(
  instagramAccountId: string
): Promise<number> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;
  const result = await client.eval(RELEASE_DM_SLOT_SCRIPT, 1, key);
  return toScriptNumber(result);
}
