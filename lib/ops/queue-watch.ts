/**
 * Queue backlog watch.
 *
 * The failure that cost the most was silent. A viral post filled the queue,
 * jobs aged past the narrow window Instagram allows for replying to a comment,
 * and by the time anyone looked at the dashboard the comments were days old and
 * unreachable — Meta will not reopen a messaging window after the fact. Nothing
 * was watching the one number that would have shown it while it was still
 * fixable.
 *
 * This checks the backlog periodically and records an operational event when it
 * is deep enough to put delivery at risk. It only reports; the worker keeps
 * draining either way.
 */

import { prisma } from "@/lib/db/client";
import { getDMQueue } from "@/lib/queue/client";
import { recordWorkerAlert } from "@/lib/ops/worker-health";

/**
 * Backlog at which a comment risks aging out before its job runs.
 *
 * At a concurrency of 20 and roughly half a second per send, the worker clears
 * about 40 jobs a second, so a thousand waiting jobs is under a minute of work
 * — comfortably inside the window. Ten thousand is not, and that is the shape
 * of the incident worth shouting about.
 */
const WARN_DEPTH = 2_000;
const ALARM_DEPTH = 10_000;

/** Don't repeat the same alert while one burst is still draining. */
const REALERT_INTERVAL_MS = 15 * 60_000;

let lastAlertAt = 0;

export interface BacklogReport {
  waiting: number;
  active: number;
  delayed: number;
  level: "ok" | "warning" | "alarm";
}

export async function checkQueueBacklog(
  now: number = Date.now()
): Promise<BacklogReport | null> {
  let counts: Record<string, number>;
  try {
    counts = await getDMQueue().getJobCounts("waiting", "active", "delayed");
  } catch {
    // A queue we cannot read is the worker's problem to report, not ours.
    return null;
  }

  const waiting = counts.waiting ?? 0;
  const active = counts.active ?? 0;
  const delayed = counts.delayed ?? 0;

  const level: BacklogReport["level"] =
    waiting >= ALARM_DEPTH ? "alarm" : waiting >= WARN_DEPTH ? "warning" : "ok";

  const report: BacklogReport = { waiting, active, delayed, level };
  if (level === "ok") {
    lastAlertAt = 0;
    return report;
  }

  if (now - lastAlertAt < REALERT_INTERVAL_MS) return report;
  lastAlertAt = now;

  const message =
    `DM queue backlog: ${waiting} waiting, ${active} active, ${delayed} delayed. ` +
    `Comments that wait too long can no longer be replied to.`;

  console.warn(`[DM Worker] ${message}`);

  try {
    await recordWorkerAlert({ level: level === "alarm" ? "error" : "warning", message });
    await prisma.operationalEvent.create({
      data: {
        source: "WORKER",
        level: level === "alarm" ? "ERROR" : "WARNING",
        message,
        payload: { waiting, active, delayed },
      },
    });
  } catch {
    // Reporting must never take the worker down.
  }

  return report;
}

/** Exposed for tests. */
export function resetBacklogAlertState() {
  lastAlertAt = 0;
}

export { WARN_DEPTH, ALARM_DEPTH, REALERT_INTERVAL_MS };
