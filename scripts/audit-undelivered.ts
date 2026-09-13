/**
 * Count who never got the link, and how many of them can still be reached.
 *
 * `resend-missed` only looks at DmLog rows with status FAILED. That misses the
 * people this exists for: someone stopped by the follow gate gets the prompt
 * logged as SENT (the prompt WAS sent) and no row at all for the link, so from
 * the database they are indistinguishable from a success. When the gate was
 * misreading Meta's "consent required" refusal as "not following", every one of
 * them was told to follow, tapped, and looped — silently.
 *
 * This reports, per campaign:
 *
 *   delivered     people who have the link (a SENT reveal, keyed `reveal:<id>`)
 *   gated         people whose only SENT row is the opening DM or follow prompt
 *   failed        people whose send failed outright
 *   reachable     of those, how many are inside Meta's 24-hour window — the
 *                 only ones a resend can actually reach
 *
 * The 24-hour window counts from the person's last message to the account.
 * DmLog records when WE sent, not when THEY wrote, so the window is estimated
 * from their most recent inbound-triggered row (a button tap or a DM trigger),
 * and marked as an estimate. Anyone older than that cannot be reached by any
 * means, and no script can reopen it.
 *
 * Read-only. Prints counts and a per-person breakdown; sends nothing.
 *
 * Usage:
 *   npx tsx scripts/audit-undelivered.ts
 *   ... --campaign <automationId>   just one campaign
 *   ... --list 50                   also print the first N reachable people
 */

import { prisma } from "@/lib/db/client";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const WINDOW_MS = 24 * 60 * 60 * 1000;

async function main() {
  const campaignArg = arg("campaign");
  const listCount = Number(arg("list") ?? 0);

  const automations = await prisma.automation.findMany({
    where: campaignArg ? { id: campaignArg } : {},
    select: {
      id: true,
      name: true,
      requireFollow: true,
      openingDmEnabled: true,
      isActive: true,
    },
    orderBy: { createdAt: "desc" },
  });

  if (automations.length === 0) {
    console.error("No campaigns found.");
    process.exit(1);
  }

  for (const automation of automations) {
    const rows = await prisma.dmLog.findMany({
      where: { automationId: automation.id },
      select: {
        commenterId: true,
        commenterName: true,
        commentId: true,
        status: true,
        dmSentAt: true,
        createdAt: true,
        errorMessage: true,
      },
      orderBy: { createdAt: "desc" },
    });

    if (rows.length === 0) continue;

    // A delivered link is a SENT row whose commentId is the reveal key — that
    // is the only row written after the gate has been cleared. A SENT row for
    // the original comment is the opening DM or the follow prompt, not the link.
    //
    // Known blind spot: the DM keyword path writes the prompt and the link to
    // the same `dm:<messageId>` row, both as SENT, so those two cannot be told
    // apart here. Such a person counts as "stopped at gate" only if they have
    // no reveal row at all, which overcounts anyone whose link went out through
    // that path. The counts below are therefore an upper bound on the damage
    // for campaigns with a DM trigger; the comment path, where the reported
    // problem happened, is exact.
    const delivered = new Set<string>();
    const anySent = new Set<string>();
    const failed = new Map<string, string | null>();
    const lastInbound = new Map<string, Date>();

    for (const row of rows) {
      const isReveal = row.commentId.startsWith("reveal:");
      if (row.status === "SENT") {
        anySent.add(row.commenterId);
        if (isReveal) delivered.add(row.commenterId);
      }
      if (row.status === "FAILED" && !failed.has(row.commenterId)) {
        failed.set(row.commenterId, row.errorMessage);
      }
      // A reveal row or a DM-trigger row only exists because the person
      // contacted us — the closest proxy we have for when their window opened.
      if (isReveal || row.commentId.startsWith("dm:")) {
        const existing = lastInbound.get(row.commenterId);
        if (!existing || row.createdAt > existing) {
          lastInbound.set(row.commenterId, row.createdAt);
        }
      }
    }

    const everyone = new Set(rows.map((r) => r.commenterId));
    const undelivered = [...everyone].filter((id) => !delivered.has(id));
    const gated = undelivered.filter(
      (id) => anySent.has(id) && !failed.has(id)
    );
    const outright = undelivered.filter((id) => failed.has(id));

    const now = Date.now();
    const reachable = undelivered.filter((id) => {
      const last = lastInbound.get(id);
      return last ? now - last.getTime() < WINDOW_MS : false;
    });

    console.log(`\n=== ${automation.name} (${automation.id}) ===`);
    console.log(
      `  follow gate: ${automation.requireFollow ? "on" : "off"}` +
        `   opening DM: ${automation.openingDmEnabled ? "on" : "off"}` +
        `   active: ${automation.isActive ? "yes" : "no"}`
    );
    console.log(`  people total      : ${everyone.size}`);
    console.log(`  got the link      : ${delivered.size}`);
    console.log(`  NEVER got it      : ${undelivered.length}`);
    console.log(`    stopped at gate : ${gated.length}`);
    console.log(`    send failed     : ${outright.length}`);
    console.log(
      `  still reachable   : ${reachable.length}  (est. inside Meta's 24h window)`
    );

    if (listCount > 0 && reachable.length > 0) {
      console.log(`\n  first ${Math.min(listCount, reachable.length)} reachable:`);
      for (const id of reachable.slice(0, listCount)) {
        const row = rows.find((r) => r.commenterId === id);
        const last = lastInbound.get(id);
        const ageH = last
          ? Math.round((now - last.getTime()) / 3_600_000)
          : null;
        console.log(
          `    ${id}  ${row?.commenterName ?? "(no name)"}  last contact ~${ageH}h ago`
        );
      }
    }
  }

  await prisma.$disconnect();
}

void main();
