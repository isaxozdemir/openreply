/**
 * Comment funnel counters.
 *
 * DmLog only ever gets a row once a comment matches a campaign, so a comment
 * that matched nothing left no trace at all. That made the most important
 * question about a viral post unanswerable: of everything people wrote, how
 * much did the keywords actually catch?
 *
 * These counters answer it without a row per comment — that write volume is
 * exactly what filled the disk before. They live in Redis as per-day integers,
 * expire on their own, and are read by the diagnostics panel.
 */

import { getRedisConnection } from "@/lib/queue/client";

const RETENTION_DAYS = 30;
const KEY_TTL_SECONDS = RETENTION_DAYS * 24 * 60 * 60;

export type FunnelStage =
  /** Comment reached the worker (it was queued and picked up). */
  | "received"
  /** At least one active campaign covered the comment's post. */
  | "campaign_matched"
  /** A campaign's keywords matched the text. */
  | "keyword_matched";

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function key(instagramAccountId: string, stage: FunnelStage, day: string) {
  return `funnel:${instagramAccountId}:${day}:${stage}`;
}

/**
 * Count one comment at one stage of the funnel. Never throws: a missing
 * counter must not cost a delivery.
 */
export async function recordFunnelStage(
  instagramAccountId: string,
  stage: FunnelStage,
  now: Date = new Date()
): Promise<void> {
  try {
    const redis = getRedisConnection();
    const k = key(instagramAccountId, stage, dayKey(now));
    const count = await redis.incr(k);
    if (count === 1) {
      await redis.expire(k, KEY_TTL_SECONDS);
    }
  } catch {
    // Counters are diagnostics, never a precondition for sending.
  }
}

export interface FunnelDay {
  date: string;
  received: number;
  campaignMatched: number;
  keywordMatched: number;
}

/**
 * Read the last `days` days of funnel counts for an account, newest last.
 */
export async function getFunnel(
  instagramAccountId: string,
  days = 7,
  now: Date = new Date()
): Promise<FunnelDay[]> {
  try {
    const redis = getRedisConnection();
    const dates: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      dates.push(dayKey(d));
    }

    const values = await redis.mget(
      ...dates.flatMap((date) => [
        key(instagramAccountId, "received", date),
        key(instagramAccountId, "campaign_matched", date),
        key(instagramAccountId, "keyword_matched", date),
      ])
    );

    return dates.map((date, index) => ({
      date,
      received: Number(values[index * 3] ?? 0),
      campaignMatched: Number(values[index * 3 + 1] ?? 0),
      keywordMatched: Number(values[index * 3 + 2] ?? 0),
    }));
  } catch {
    return [];
  }
}
