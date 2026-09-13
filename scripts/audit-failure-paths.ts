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
  if (commentId.startsWith("gate:")) return "follow gate (blocked)";
  if (commentId.startsWith("followup:")) return "follow-up (thank-you)";
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

  // When a subcode is concentrated in time, it was an episode — an outage, a
  // bad deploy, one viral post whose comments all aged out together — rather
  // than a steady condition. That distinction decides whether there is anything
  // left to fix, so print a per-day count for the biggest subcodes.
  const byDay = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const day = row.createdAt.toISOString().slice(0, 10);
    const sub = subcodeOf(row.errorMessage);
    const inner = byDay.get(sub) ?? new Map<string, number>();
    inner.set(day, (inner.get(day) ?? 0) + 1);
    byDay.set(sub, inner);
  }

  for (const [sub, days] of [...byDay.entries()].sort(
    (a, b) =>
      [...b[1].values()].reduce((x, y) => x + y, 0) -
      [...a[1].values()].reduce((x, y) => x + y, 0)
  )) {
    const total = [...days.values()].reduce((x, y) => x + y, 0);
    if (total < 10) continue;
    console.log(`\n  sub=${sub} by day (${total} total):`);
    for (const [day, count] of [...days.entries()].sort()) {
      const bar = "#".repeat(Math.min(50, Math.ceil(count / 5)));
      console.log(`    ${day}  ${String(count).padStart(5)}  ${bar}`);
    }
  }

  await prisma.$disconnect();
}

void main();
