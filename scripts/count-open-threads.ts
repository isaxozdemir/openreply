/**
 * How many people does this account have an open DM thread with, and how many
 * of them never got the link?
 *
 * "Has a thread" is not the same as "can be messaged": Meta's 24-hour window
 * counts from the person's last message to the account, and a thread's
 * updated_time moves for our own sends too. So this reports the thread count as
 * the reach a HUMAN_AGENT resend (7-day window) could plausibly work against,
 * and says plainly that it is an upper bound, not a promise.
 *
 * Read-only.
 *
 * Usage:
 *   npx tsx scripts/count-open-threads.ts --campaign <automationId>
 *   ... --pages 40    conversation pages to walk (default 20, 100 per page)
 */

import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { getMetaGraphApiVersion } from "@/lib/env";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function main() {
  const campaignArg = arg("campaign");
  const maxPages = Number(arg("pages") ?? 20);

  if (!campaignArg) {
    console.error("Missing --campaign <automationId>.");
    process.exit(1);
  }

  const automation = await prisma.automation.findUnique({
    where: { id: campaignArg },
    include: { instagramAccount: true },
  });

  if (!automation?.instagramAccount?.accessToken) {
    console.error("Campaign not found, or its account has no token.");
    process.exit(1);
  }

  const accessToken = decryptToken(automation.instagramAccount.accessToken);
  const igId = automation.instagramAccount.instagramId;

  const rows = await prisma.dmLog.findMany({
    where: { automationId: automation.id },
    select: { commenterId: true, commentId: true, status: true },
  });

  const delivered = new Set(
    rows
      .filter((r) => r.status === "SENT" && r.commentId.startsWith("reveal:"))
      .map((r) => r.commenterId)
  );
  const touched = new Set(
    rows
      .filter((r) => !r.commentId.startsWith("followup:"))
      .map((r) => r.commenterId)
  );

  const now = Date.now();
  let threads = 0;
  let within24h = 0;
  let within7d = 0;
  let undeliveredWithThread = 0;
  let undeliveredWithin7d = 0;

  const first = new URL(
    `https://graph.instagram.com/${getMetaGraphApiVersion()}/${igId}/conversations`
  );
  first.searchParams.set("platform", "instagram");
  first.searchParams.set("fields", "id,updated_time,participants");
  first.searchParams.set("limit", "100");
  first.searchParams.set("access_token", accessToken);

  let url: string | null = first.toString();
  let pages = 0;

  while (url && pages < maxPages) {
    const response: Response = await fetch(url);
    const body: string = await response.text();
    if (!response.ok) {
      console.error(`conversations read failed: HTTP ${response.status} ${body.slice(0, 200)}`);
      break;
    }

    const parsed = JSON.parse(body) as {
      data?: {
        updated_time?: string;
        participants?: { data?: { id: string }[] };
      }[];
      paging?: { next?: string };
    };

    for (const conversation of parsed.data ?? []) {
      const updated = conversation.updated_time
        ? new Date(conversation.updated_time).getTime()
        : null;
      const age = updated === null ? Infinity : now - updated;

      for (const participant of conversation.participants?.data ?? []) {
        if (participant.id === igId) continue;
        threads++;
        if (age < DAY_MS) within24h++;
        if (age < 7 * DAY_MS) within7d++;
        if (touched.has(participant.id) && !delivered.has(participant.id)) {
          undeliveredWithThread++;
          if (age < 7 * DAY_MS) undeliveredWithin7d++;
        }
      }
    }

    url = parsed.paging?.next ?? null;
    pages++;
  }

  console.log(`Campaign: ${automation.name}`);
  console.log(`Walked ${pages} page(s) of conversations\n`);
  console.log(`  DM threads seen                     : ${threads}`);
  console.log(`  active in last 24h                  : ${within24h}`);
  console.log(`  active in last 7 days               : ${within7d}`);
  console.log(`\n  of those, from this campaign and still without the link:`);
  console.log(`  has a thread at all                 : ${undeliveredWithThread}`);
  console.log(`  thread active in last 7 days        : ${undeliveredWithin7d}  ← what --human-agent could try`);
  console.log(
    `\n  Upper bound, not a promise: the window counts from THEIR last\n` +
      `  message, and updated_time also moves when we send. Some of these\n` +
      `  will still refuse with 2534022.`
  );

  await prisma.$disconnect();
  process.exit(0);
}

void main();
