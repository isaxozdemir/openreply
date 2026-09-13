/**
 * Show WHICH step produced each failure, not just which error it was.
 *
 * audit-failures groups by subcode; this groups by the row key, which says
 * where in the flow the send was attempted:
 *
 *   reveal:<igsid>   a button tap — the link send, after the gate
 *   dm:<messageId>   a DM keyword trigger
 *   <numeric id>     a comment — the private reply
 *
 * The distinction decides what a fix would even look like. 976 failures with
 * "thread archived or deleted" mean something very different on the tap path
 * (we are messaging people whose thread is gone, long after they tapped) than
 * on the comment path (the private reply itself is being refused).
 *
 * Read-only.
 *
 * Usage:
 *   npx tsx scripts/audit-failure-paths.ts --campaign <automationId>
 *   ... --hours 24     window for the recent column (default 24)
 */

import { prisma } from "@/lib/db/client";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function pathOf(commentId: string): string {
  if (commentId.startsWith("reveal:")) return "reveal (button tap)";
  if (commentId.startsWith("dm:")) return "dm (keyword trigger)";
  return "comment (private reply)";
}

function subcodeOf(message: string | null): string {
  if (!message) return "(none)";
  const sub = message.match(/sub=(\d+)/)?.[1];
  if (sub) return sub;
  if (/archived or deleted/i.test(message)) return "2534001";
  if (/invalid for a private reply/i.test(message)) return "2534025";
  if (/cannot be found/i.test(message)) return "2534014";
  if (/outside of allowed window/i.test(message)) return "2534022";
  return "other";
}

async function main() {
  const campaignArg = arg("campaign");
  const hours = Number(arg("hours") ?? 24);
  const since = new Date(Date.now() - hours * 3_600_000);

  if (!campaignArg) {
    console.error("Missing --campaign <automationId>.");
    process.exit(1);
  }

  const rows = await prisma.dmLog.findMany({
    where: { automationId: campaignArg, status: "FAILED" },
    select: {
      commentId: true,
      errorMessage: true,
      createdAt: true,
      dmSentAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  console.log(`Failed rows: ${rows.length}\n`);

  const combos = new Map<string, { all: number; recent: number }>();
  for (const row of rows) {
    const key = `${pathOf(row.commentId)}  ×  sub=${subcodeOf(row.errorMessage)}`;
    const entry = combos.get(key) ?? { all: 0, recent: 0 };
    entry.all++;
    if (row.createdAt >= since) entry.recent++;
    combos.set(key, entry);
  }

  console.log(`  ${"path × subcode".padEnd(46)}${"all".padEnd(8)}last ${hours}h`);
  for (const [key, entry] of [...combos.entries()].sort(
    (a, b) => b[1].all - a[1].all
  )) {
    console.log(
      `  ${key.padEnd(46)}${String(entry.all).padEnd(8)}${entry.recent}`
    );
  }

  // On the reveal path, how long after the tap did the send fail? A long gap
  // points at the delayed follow-up or a stale queue, a short one at the send
  // itself. dmSentAt is null for a row that never delivered, so this uses the
  // spread between the row's creation and its last update instead.
  const revealRows = rows.filter((r) => r.commentId.startsWith("reveal:"));
  if (revealRows.length > 0) {
    console.log(
      `\nReveal-path failures: ${revealRows.length}` +
        `\n  oldest: ${revealRows[revealRows.length - 1]?.createdAt.toISOString()}` +
        `\n  newest: ${revealRows[0]?.createdAt.toISOString()}`
    );
  }

  await prisma.$disconnect();
}

void main();
