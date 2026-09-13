/**
 * One plain answer: how many people commented, and how many got the link.
 *
 * Two sources, and the difference between them matters:
 *
 * DmLog has one row per person a campaign ACTED ON — it is written only after
 * the keywords match, so it cannot see a comment that matched nothing. It is
 * exact for "who did we try to send to, and what happened".
 *
 * The Redis funnel counters (lib/ops/funnel.ts) do count every comment that
 * reached the worker, but they are per-account rather than per-campaign, start
 * only from the day that counter was added, and expire after 30 days. They are
 * reported separately here, never mixed into the campaign totals.
 *
 * Delivery means a SENT row keyed `reveal:<igsid>` — the link. A SENT row
 * against the comment id is the opening DM or the follow prompt, and a
 * `followup:` row is the thank-you; neither is the link.
 *
 * Read-only.
 *
 * Usage:
 *   npx tsx scripts/report-campaign.ts
 *   ... --campaign <automationId>   just one campaign
 */

import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function pct(part: number, whole: number): string {
  if (whole === 0) return "—";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

async function main() {
  const campaignArg = arg("campaign");

  const automations = await prisma.automation.findMany({
    where: campaignArg ? { id: campaignArg } : {},
    select: {
      id: true,
      name: true,
      instagramAccountId: true,
      instagramAccount: { select: { instagramId: true, username: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  for (const automation of automations) {
    const rows = await prisma.dmLog.findMany({
      where: { automationId: automation.id },
      select: {
        commenterId: true,
        commentId: true,
        status: true,
        createdAt: true,
      },
    });

    if (rows.length === 0) continue;

    const people = new Set<string>();
    const gotLink = new Set<string>();
    const failedSend = new Set<string>();
    let firstSeen: Date | null = null;
    let lastSeen: Date | null = null;

    for (const row of rows) {
      // The thank-you is not the link, in either direction.
      if (row.commentId.startsWith("followup:")) continue;

      people.add(row.commenterId);
      if (row.status === "SENT" && row.commentId.startsWith("reveal:")) {
        gotLink.add(row.commenterId);
      }
      if (row.status === "FAILED") failedSend.add(row.commenterId);

      if (!firstSeen || row.createdAt < firstSeen) firstSeen = row.createdAt;
      if (!lastSeen || row.createdAt > lastSeen) lastSeen = row.createdAt;
    }

    // Someone with a failed send AND a delivered link is a success: the resend,
    // or a later attempt, got through.
    for (const id of gotLink) failedSend.delete(id);
    const stoppedBefore = [...people].filter(
      (id) => !gotLink.has(id) && !failedSend.has(id)
    );

    console.log(`\n=== ${automation.name} ===`);
    console.log(`  @${automation.instagramAccount.username ?? "?"}`);
    if (firstSeen && lastSeen) {
      console.log(
        `  ${firstSeen.toISOString().slice(0, 10)} → ${lastSeen
          .toISOString()
          .slice(0, 10)}`
      );
    }
    console.log(`\n  People the campaign acted on : ${people.size}`);
    console.log(
      `  Got the link                 : ${gotLink.size}  (${pct(gotLink.size, people.size)})`
    );
    console.log(
      `  Send failed                  : ${failedSend.size}  (${pct(failedSend.size, people.size)})`
    );
    console.log(
      `  Stopped before any send      : ${stoppedBefore.length}  (${pct(stoppedBefore.length, people.size)})`
    );
    console.log(
      `\n  "Acted on" counts people whose comment matched the keywords — a\n` +
        `  comment that matched nothing never reaches DmLog, so the real\n` +
        `  number of commenters is higher. See the funnel counts below.`
    );
  }

  // Per-account comment counts, for whatever days the counters cover.
  const accounts = [
    ...new Map(
      automations.map((a) => [
        a.instagramAccount.instagramId,
        a.instagramAccount.username,
      ])
    ).entries(),
  ];

  try {
    const redis = getRedisConnection();
    for (const [igId, username] of accounts) {
      const keys = await redis.keys(`funnel:${igId}:*:received`);
      if (keys.length === 0) continue;

      const days: { day: string; received: number; matched: number }[] = [];
      for (const receivedKey of keys.sort()) {
        const day = receivedKey.split(":")[2];
        const [received, matched] = await Promise.all([
          redis.get(receivedKey),
          redis.get(`funnel:${igId}:${day}:keyword_matched`),
        ]);
        days.push({
          day,
          received: Number(received ?? 0),
          matched: Number(matched ?? 0),
        });
      }

      const totalReceived = days.reduce((sum, d) => sum + d.received, 0);
      const totalMatched = days.reduce((sum, d) => sum + d.matched, 0);

      console.log(`\n=== comments reaching the worker — @${username ?? igId} ===`);
      console.log(
        `  (counted per account, not per campaign; only from the day this\n` +
          `   counter was added, and only the last 30 days)\n`
      );
      console.log(`  ${"day".padEnd(14)}${"comments".padEnd(12)}matched keywords`);
      for (const d of days) {
        console.log(
          `  ${d.day.padEnd(14)}${String(d.received).padEnd(12)}${d.matched}`
        );
      }
      console.log(
        `  ${"TOTAL".padEnd(14)}${String(totalReceived).padEnd(12)}${totalMatched}` +
          `  (${pct(totalMatched, totalReceived)} matched)`
      );
    }
  } catch {
    console.log("\n(funnel counters unavailable — Redis not reachable)");
  }

  await prisma.$disconnect();
  process.exit(0);
}

void main();
