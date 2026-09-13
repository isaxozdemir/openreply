/**
 * Break down why sends failed, by Meta error subcode and over time.
 *
 * audit-undelivered counts how many people never got the link; this says why
 * for the ones whose send actually failed. The two groups need different
 * answers — a closed messaging window is nothing like an expired token — and
 * the subcode is the only thing that tells them apart.
 *
 * The time split matters as much as the totals: a campaign whose newest
 * failure is minutes old is still losing people right now, and the recent
 * column is the one to read. An error that dominates the all-time count but
 * has stopped appearing is already fixed.
 *
 * Read-only.
 *
 * Usage:
 *   npx tsx scripts/audit-failures.ts
 *   ... --campaign <automationId>   just one campaign
 *   ... --hours 24                  window for the "recent" column (default 24)
 *   ... --samples 3                 example messages per subcode (default 2)
 */

import { prisma } from "@/lib/db/client";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

// What each subcode means, and whether anything can be done about it.
const EXPLANATIONS: Record<string, string> = {
  "2534022": "outside the 24h messaging window — unreachable, cannot be reopened",
  "2534025": "comment's single private reply already used — often already delivered",
  "2534014": "user cannot be found — account deleted or blocked",
  "2534001": "thread archived/deleted by its owner",
  "1545133": "transient 'service temporarily unavailable' (code 2)",
  "2534013": "rate or policy limit on private replies",
};

function classify(message: string | null): string {
  if (!message) return "(no message)";
  const sub = message.match(/sub=(\d+)/)?.[1];
  if (sub) return sub;
  // Errors recorded before subcodes were captured, or non-Meta failures.
  if (/outside of allowed window/i.test(message)) return "2534022";
  if (/invalid for a private reply/i.test(message)) return "2534025";
  if (/cannot be found/i.test(message)) return "2534014";
  if (/archived or deleted/i.test(message)) return "2534001";
  if (/temporarily unavailable/i.test(message)) return "1545133";
  if (/token/i.test(message)) return "token";
  return "other";
}

async function main() {
  const campaignArg = arg("campaign");
  const hours = Number(arg("hours") ?? 24);
  const sampleCount = Number(arg("samples") ?? 2);
  const since = new Date(Date.now() - hours * 3_600_000);

  const automations = await prisma.automation.findMany({
    where: campaignArg ? { id: campaignArg } : {},
    select: { id: true, name: true },
    orderBy: { createdAt: "desc" },
  });

  for (const automation of automations) {
    const rows = await prisma.dmLog.findMany({
      where: { automationId: automation.id, status: "FAILED" },
      select: { errorMessage: true, createdAt: true, attempts: true },
      orderBy: { createdAt: "desc" },
    });

    if (rows.length === 0) continue;

    const total = new Map<string, number>();
    const recent = new Map<string, number>();
    const samples = new Map<string, string[]>();

    for (const row of rows) {
      const key = classify(row.errorMessage);
      total.set(key, (total.get(key) ?? 0) + 1);
      if (row.createdAt >= since) {
        recent.set(key, (recent.get(key) ?? 0) + 1);
      }
      const seen = samples.get(key) ?? [];
      if (seen.length < sampleCount && row.errorMessage) {
        seen.push(row.errorMessage.slice(0, 160));
        samples.set(key, seen);
      }
    }

    const newest = rows[0]?.createdAt;
    const ageMin = newest
      ? Math.round((Date.now() - newest.getTime()) / 60_000)
      : null;

    console.log(`\n=== ${automation.name} (${automation.id}) ===`);
    console.log(`  failed rows: ${rows.length}`);
    if (ageMin !== null) {
      console.log(
        `  newest failure: ${ageMin} min ago` +
          (ageMin < 60 ? "  ← still failing now" : "")
      );
    }
    console.log(
      `\n  ${"subcode".padEnd(12)}${"all".padEnd(8)}${`last ${hours}h`.padEnd(10)}meaning`
    );

    const ordered = [...total.entries()].sort((a, b) => b[1] - a[1]);
    for (const [key, count] of ordered) {
      const recentCount = recent.get(key) ?? 0;
      console.log(
        `  ${key.padEnd(12)}${String(count).padEnd(8)}${String(recentCount).padEnd(10)}` +
          (EXPLANATIONS[key] ?? "")
      );
    }

    // Anything still happening is the only part that can be acted on; the rest
    // is history that a resend, not a code change, has to clean up.
    const stillActive = ordered.filter(([key]) => (recent.get(key) ?? 0) > 0);
    if (stillActive.length > 0) {
      console.log(`\n  Still occurring in the last ${hours}h:`);
      for (const [key] of stillActive) {
        console.log(`    sub=${key}  ${EXPLANATIONS[key] ?? ""}`);
        for (const sample of samples.get(key) ?? []) {
          console.log(`      e.g. ${sample}`);
        }
      }
    }
  }

  await prisma.$disconnect();
}

void main();
