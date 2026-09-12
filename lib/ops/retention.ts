/**
 * Data retention.
 *
 * Several tables are append-only in normal operation: every webhook Meta sends,
 * every operational event, and one dedup row per comment ever seen. Nothing
 * deleted them, so on a busy account the database grows without bound until the
 * volume fills and Postgres starts refusing writes — which surfaces as 500s
 * across the app, not as an obvious disk error.
 *
 * These windows keep what is useful for debugging and drop what is not:
 *
 * - WebhookEvent carries the full Meta payload and is by far the heaviest
 *   writer (one row per delivery). A week is enough to investigate a bad
 *   delivery; older rows are dead weight.
 * - OperationalEvent is for spotting recent trouble, so 30 days.
 * - ProcessedComment is the dedup guard. Its window must stay comfortably
 *   longer than any path that could re-enqueue an old comment — the polling
 *   reconciler only looks at recent media, so 30 days leaves wide margin.
 * - DmLog is the user-visible send history shown in the dashboard, so it is
 *   kept far longer and is not part of the aggressive sweep.
 * - LinkClick backs click/CTR stats, kept at a year.
 */

import { prisma } from "@/lib/db/client";

export const RETENTION_DAYS = {
  webhookEvent: 7,
  operationalEvent: 30,
  processedComment: 30,
  linkClick: 365,
  dmLog: 365,
} as const;

export type RetentionResult = Record<keyof typeof RETENTION_DAYS, number>;

function cutoff(days: number, now: Date): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Delete rows past their retention window.
 *
 * Each table is swept in bounded batches rather than one large statement: a
 * single unbounded DELETE over months of backlog holds a long transaction and
 * bloats WAL — the opposite of what a disk-pressure fix should do.
 */
export async function pruneExpiredRecords(
  now: Date = new Date(),
  batchSize = 5_000
): Promise<RetentionResult> {
  const deleted: RetentionResult = {
    webhookEvent: 0,
    operationalEvent: 0,
    processedComment: 0,
    linkClick: 0,
    dmLog: 0,
  };

  deleted.webhookEvent = await pruneTable(
    (before, limit) => prisma.$executeRaw`
      DELETE FROM "WebhookEvent"
      WHERE "id" IN (
        SELECT "id" FROM "WebhookEvent"
        WHERE "createdAt" < ${before}
        LIMIT ${limit}
      )`,
    cutoff(RETENTION_DAYS.webhookEvent, now),
    batchSize
  );

  deleted.operationalEvent = await pruneTable(
    (before, limit) => prisma.$executeRaw`
      DELETE FROM "OperationalEvent"
      WHERE "id" IN (
        SELECT "id" FROM "OperationalEvent"
        WHERE "createdAt" < ${before}
        LIMIT ${limit}
      )`,
    cutoff(RETENTION_DAYS.operationalEvent, now),
    batchSize
  );

  deleted.processedComment = await pruneTable(
    (before, limit) => prisma.$executeRaw`
      DELETE FROM "ProcessedComment"
      WHERE "id" IN (
        SELECT "id" FROM "ProcessedComment"
        WHERE "seenAt" < ${before}
        LIMIT ${limit}
      )`,
    cutoff(RETENTION_DAYS.processedComment, now),
    batchSize
  );

  deleted.linkClick = await pruneTable(
    (before, limit) => prisma.$executeRaw`
      DELETE FROM "LinkClick"
      WHERE "id" IN (
        SELECT "id" FROM "LinkClick"
        WHERE "createdAt" < ${before}
        LIMIT ${limit}
      )`,
    cutoff(RETENTION_DAYS.linkClick, now),
    batchSize
  );

  deleted.dmLog = await pruneTable(
    (before, limit) => prisma.$executeRaw`
      DELETE FROM "DmLog"
      WHERE "id" IN (
        SELECT "id" FROM "DmLog"
        WHERE "createdAt" < ${before}
        LIMIT ${limit}
      )`,
    cutoff(RETENTION_DAYS.dmLog, now),
    batchSize
  );

  return deleted;
}

/**
 * Run one table's delete in batches until a pass removes nothing.
 *
 * Capped so a single invocation cannot run unbounded: whatever is left is
 * picked up by the next scheduled run.
 */
async function pruneTable(
  run: (before: Date, limit: number) => Promise<number>,
  before: Date,
  batchSize: number,
  maxBatches = 40
): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const removed = await run(before, batchSize);
    total += removed;
    if (removed < batchSize) break;
  }
  return total;
}
