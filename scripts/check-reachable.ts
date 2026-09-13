/**
 * Find out who is actually still inside Meta's 24-hour messaging window.
 *
 * audit-undelivered estimates reachability from a person's most recent
 * inbound-triggered DmLog row (`reveal:` or `dm:`). That estimate is wrong in
 * exactly the case that matters: someone stopped by the follow gate has
 * neither row, so they look unreachable no matter how recently they tapped.
 * A blanket "still reachable: 0" from that script is therefore not evidence
 * that nobody can be reached.
 *
 * The authority on the window is Meta, not our database. This asks Meta
 * directly: it lists the account's conversations, which are ordered by recent
 * activity and carry `updated_time`. A conversation whose last activity is
 * under 24 hours old is one we can still send to.
 *
 * Cross-referenced against who never got the link, that gives the real
 * recovery list — the people a resend can still reach today.
 *
 * Read-only. Prints the list; sends nothing.
 *
 * Usage:
 *   npx tsx scripts/check-reachable.ts --campaign <automationId>
 *   ... --pages 20     how many pages of conversations to walk (default 10)
 */

import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { getMetaGraphApiVersion } from "@/lib/env";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const WINDOW_MS = 24 * 60 * 60 * 1000;

type Conversation = {
  id: string;
  updated_time?: string;
  participants?: { data?: { id: string; username?: string }[] };
};

async function main() {
  const campaignArg = arg("campaign");
  const maxPages = Number(arg("pages") ?? 10);

  if (!campaignArg) {
    console.error("Missing --campaign <automationId>.");
    process.exit(1);
  }

  const automation = await prisma.automation.findUnique({
    where: { id: campaignArg },
    include: { instagramAccount: true },
  });

  if (!automation?.instagramAccount?.accessToken) {
    console.error("Campaign not found, or its Instagram account has no token.");
    process.exit(1);
  }

  const accessToken = decryptToken(automation.instagramAccount.accessToken);
  const igId = automation.instagramAccount.instagramId;

  // Who never got the link: no SENT row keyed `reveal:<igsid>`.
  const rows = await prisma.dmLog.findMany({
    where: { automationId: automation.id },
    select: { commenterId: true, commenterName: true, commentId: true, status: true },
  });

  const delivered = new Set(
    rows
      .filter((r) => r.status === "SENT" && r.commentId.startsWith("reveal:"))
      .map((r) => r.commenterId)
  );
  const names = new Map<string, string | null>();
  for (const row of rows) {
    if (!names.has(row.commenterId)) names.set(row.commenterId, row.commenterName);
  }
  const undelivered = new Set(
    [...names.keys()].filter((id) => !delivered.has(id))
  );

  console.log(`Campaign: ${automation.name}`);
  console.log(`Never got the link: ${undelivered.size}`);
  console.log(`\nAsking Meta which conversations are still open...`);

  const now = Date.now();
  const open: { id: string; name: string | null; ageH: number }[] = [];
  let url: string | null = null;
  {
    const first = new URL(
      `https://graph.instagram.com/${getMetaGraphApiVersion()}/${igId}/conversations`
    );
    // `platform=instagram` is required here — see getConversations in
    // lib/meta/client.ts; without it the endpoint does not return IG threads.
    first.searchParams.set("platform", "instagram");
    first.searchParams.set("fields", "id,updated_time,participants");
    first.searchParams.set("limit", "100");
    first.searchParams.set("access_token", accessToken);
    url = first.toString();
  }

  let scanned = 0;
  let pages = 0;
  let stoppedEarly = false;

  while (url && pages < maxPages) {
    const response: Response = await fetch(url);
    const body: string = await response.text();

    if (!response.ok) {
      console.error(`  conversations read failed: HTTP ${response.status} ${body.slice(0, 300)}`);
      break;
    }

    const parsed = JSON.parse(body) as {
      data?: Conversation[];
      paging?: { next?: string };
    };

    for (const conversation of parsed.data ?? []) {
      scanned++;
      const updated = conversation.updated_time
        ? new Date(conversation.updated_time).getTime()
        : null;
      if (updated === null) continue;

      // Conversations come back newest-first, so once one is past the window
      // every page after it is too. Nothing left worth reading.
      if (now - updated >= WINDOW_MS) {
        stoppedEarly = true;
        break;
      }

      for (const participant of conversation.participants?.data ?? []) {
        if (participant.id === igId) continue;
        if (!undelivered.has(participant.id)) continue;
        open.push({
          id: participant.id,
          name: names.get(participant.id) ?? participant.username ?? null,
          ageH: Math.round((now - updated) / 3_600_000),
        });
      }
    }

    if (stoppedEarly) break;
    url = parsed.paging?.next ?? null;
    pages++;
  }

  console.log(`  scanned ${scanned} conversations across ${pages + 1} page(s)`);
  if (!stoppedEarly && url) {
    console.log(
      `  ⚠ stopped at the --pages limit, not at the window edge — raise --pages to see more`
    );
  }

  console.log(`\nStill reachable AND never got the link: ${open.length}`);
  for (const person of open) {
    console.log(`  ${person.id}  ${person.name ?? "(no name)"}  last activity ~${person.ageH}h ago`);
  }

  if (open.length === 0) {
    console.log(
      `\nNobody is inside the window. Meta counts it from the person's last\n` +
        `message to the account, and it cannot be reopened from our side — so\n` +
        `these people cannot be reached by any script, including resend-missed.`
    );
  }

  await prisma.$disconnect();
}

void main();
