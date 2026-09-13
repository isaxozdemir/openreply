/**
 * Resend the campaign link to people whose delivery failed but who already
 * have an open conversation with the account.
 *
 * Why this can work at all: a failed send does not mean the conversation is
 * closed. If the person tapped a button, replied, or received the follow
 * prompt, a normal direct message is allowed even though the comment's single
 * private reply is long gone. Those are the people this reaches.
 *
 * Who it covers: everyone with no `reveal:` row — both sends that failed and
 * people the follow gate stopped. The latter have no failed row at all (their
 * prompt is logged SENT, and nothing records that the link never followed), so
 * selecting on FAILED alone silently skipped every one of them.
 *
 * Who is deliberately NOT included:
 *   - anyone with a SENT reveal row (they have the link)
 *   - subcode 2534014, "user cannot be found" — the account is gone
 *   - anyone with no evidence of an open conversation
 *
 * Meta's 24-hour messaging window is the binding constraint. It counts from the
 * person's last message TO the account — and note that a conversation's
 * `updated_time` does not track it, because our own sends bump that too. A
 * conversation Meta lists as recently active can still refuse every message
 * with subcode 2534022, which is exactly what a run against this campaign hit:
 * 39 "open" conversations, ten sends, ten refusals.
 *
 * --human-agent is the one way past it. Meta's HUMAN_AGENT tag extends the
 * window to 7 days for a message a person has decided to send, one at a time,
 * to resolve something — an apology-and-deliver run like this one. It is not
 * for automation: the worker never sends it, and tagging routine campaign
 * traffic this way violates Meta's policy and risks the account.
 *
 * Refusals are reported per subcode, never retried.
 *
 * Usage:
 *   npx tsx scripts/resend-missed.ts --campaign <automationId>           # dry run
 *   npx tsx scripts/resend-missed.ts --campaign <automationId> --send    # actually send
 *   ... --limit 50        cap how many are attempted (default 100)
 *   ... --delay 1500      ms between sends (default 1500)
 *   ... --human-agent     send under Meta's HUMAN_AGENT tag (7-day window).
 *                         Manual recovery only — read the note above first.
 */

import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { sendDirectMessage, sendDirectMessageWithLinkButton } from "@/lib/meta/client";
import { getMetaGraphApiVersion } from "@/lib/env";
import {
  buildTrackedUrl,
  renderMessageWithTracking,
  renderMessageWithoutLink,
} from "@/lib/tracking/message";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const AUTOMATION_ID = arg("campaign");
const SEND = process.argv.includes("--send");
// Meta's HUMAN_AGENT tag extends the reply window from 24 hours to 7 days. It
// is for a message a person has decided to send, one at a time, to resolve
// something — which is what this script is. It is NOT for automation, and the
// worker never uses it. Opt in explicitly with --human-agent, and only for a
// genuine apology-and-deliver run like this one; tagging routine campaign
// traffic this way is a policy violation and risks the account.
const HUMAN_AGENT = process.argv.includes("--human-agent");
const LIMIT = Number(arg("limit") ?? 100);
const DELAY_MS = Number(arg("delay") ?? 1500);
// Prepended to the campaign message. These people commented a while ago and
// got nothing, so the DM arrives unprompted and out of the blue — the apology
// is what makes it read as a fix rather than as spam.
const PREFIX =
  arg("prefix") ??
  "Kusura bakma, bir aksaklık yüzünden programı sana gönderemedik. İşte programın:";

// "User cannot be found" — the Instagram account no longer exists, so there is
// nobody to message. Every other failure is worth an attempt.
const HOPELESS_SUBCODE = "2534014";

/**
 * IGSIDs whose conversation Meta shows as active within the last 24 hours.
 *
 * Treat this as an ordering hint, NOT as proof the window is open. The window
 * counts from the person's last message to us, while `updated_time` moves for
 * any activity in the thread — our own sends included — so a conversation can
 * look fresh here and still refuse every message. It is used only to try the
 * likeliest people first. Conversations come back newest-first, so the walk
 * stops at the first one past 24 hours. Returns null if the read fails, so the
 * caller can fall back rather than treat "unknown" as "closed".
 */
async function fetchOpenConversationIds(
  accessToken: string,
  igUserId: string
): Promise<Set<string> | null> {
  const open = new Set<string>();
  const windowMs = 24 * 60 * 60 * 1000;
  const now = Date.now();

  const first = new URL(
    `https://graph.instagram.com/${getMetaGraphApiVersion()}/${igUserId}/conversations`
  );
  first.searchParams.set("platform", "instagram");
  first.searchParams.set("fields", "id,updated_time,participants");
  first.searchParams.set("limit", "100");
  first.searchParams.set("access_token", accessToken);

  let url: string | null = first.toString();
  let pages = 0;

  while (url && pages < 20) {
    const response: Response = await fetch(url);
    if (!response.ok) return open.size > 0 ? open : null;

    const parsed = JSON.parse(await response.text()) as {
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
      if (updated === null) continue;
      if (now - updated >= windowMs) return open;
      for (const participant of conversation.participants?.data ?? []) {
        if (participant.id !== igUserId) open.add(participant.id);
      }
    }

    url = parsed.paging?.next ?? null;
    pages++;
  }

  return open;
}

async function main() {
  if (!AUTOMATION_ID) {
    console.error(
      "Missing --campaign <automationId>.\n" +
        "Find it in the campaign URL in the dashboard, or:\n" +
        `  psql "$DATABASE_URL" -c 'SELECT id, name FROM "Automation";'`
    );
    process.exit(1);
  }

  const automation = await prisma.automation.findUnique({
    where: { id: AUTOMATION_ID },
    include: {
      instagramAccount: true,
      trackedLinks: {
        select: { slug: true, label: true, destinationUrl: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!automation?.instagramAccount?.accessToken) {
    console.error("Campaign not found, or its Instagram account has no token.");
    process.exit(1);
  }

  const accessToken = decryptToken(automation.instagramAccount.accessToken);

  // Everyone who already has the LINK, by IGSID. Not merely everyone with a
  // SENT row: the follow prompt and the opening DM are logged SENT too, and
  // treating those as delivery is exactly what hides a gate-stopped person.
  // The link is the reveal row, keyed `reveal:<igsid>`, written only once the
  // gate has been cleared.
  //
  // Exception: the DM keyword path writes the prompt and the link to the same
  // `dm:<messageId>` row, so a link delivered that way has no reveal row and
  // its recipient stays a candidate here. That risks a duplicate send to
  // someone who already has it — chosen deliberately over the alternative,
  // which is never reaching anyone the gate stopped.
  const delivered = await prisma.dmLog.findMany({
    where: { automationId: automation.id, status: "SENT" },
    select: { commenterId: true, commentId: true },
  });
  const deliveredIds = new Set(
    delivered
      .filter((row) => row.commentId.startsWith("reveal:"))
      .map((row) => row.commenterId)
  );

  // Everyone this campaign ever touched, not just the failures. A person
  // stopped by the follow gate has NO failed row — the prompt they got is
  // logged as SENT, because the prompt really was sent, and nothing records
  // that the link never followed. Selecting on FAILED alone therefore misses
  // them entirely, which is how a campaign ended up with 1037 gate-stopped
  // people none of whom this script could see.
  const everyone = await prisma.dmLog.findMany({
    where: { automationId: automation.id },
    select: {
      commenterId: true,
      commenterName: true,
      errorMessage: true,
      status: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const failed = everyone.filter((row) => row.status === "FAILED");

  // One attempt per person, keeping their most recent row.
  const candidates = new Map<
    string,
    { commenterName: string | null; errorMessage: string | null }
  >();
  for (const row of everyone) {
    // `deliveredIds` is keyed on a SENT reveal row, so this is the real test of
    // "already has the link" — a SENT prompt does not count.
    if (deliveredIds.has(row.commenterId)) continue;
    if (row.errorMessage?.includes(HOPELESS_SUBCODE)) continue;
    if (candidates.has(row.commenterId)) continue;
    candidates.set(row.commenterId, {
      commenterName: row.commenterName,
      errorMessage: row.errorMessage,
    });
  }

  // Meta's 24-hour window is the binding constraint, and it is invisible from
  // DmLog. Ask Meta which conversations are still open and try those first:
  // without this, a campaign with thousands of long-closed candidates spends
  // its consecutive-refusal budget on them and stops before reaching anyone
  // who could still have been helped. Pass --all to skip the ordering.
  const ORDER_BY_WINDOW = !process.argv.includes("--all");
  let ordered = [...candidates.entries()];

  if (ORDER_BY_WINDOW) {
    const open = await fetchOpenConversationIds(
      accessToken,
      automation.instagramAccount.instagramId
    );
    if (open === null) {
      console.log(
        "Could not read conversations; sending in database order instead.\n"
      );
    } else {
      const inWindow = ordered.filter(([id]) => open.has(id));
      const rest = ordered.filter(([id]) => !open.has(id));
      console.log(
        `Recently active conversations: ${inWindow.length} of ${ordered.length} candidates (tried first; not a guarantee the window is open)`
      );
      ordered = [...inWindow, ...rest];
    }
  }

  const targets = ordered.slice(0, LIMIT);

  const newest = failed[0]?.createdAt;
  const ageHours = newest
    ? Math.round((Date.now() - newest.getTime()) / 3_600_000)
    : null;

  console.log(`Campaign      : ${automation.name}`);
  console.log(`Failed rows   : ${failed.length}`);
  if (ageHours !== null) {
    console.log(
      `Newest failure: ${ageHours}h ago` +
        (ageHours > 24
          ? "  ⚠ past Meta's 24h window — expect every send to be refused"
          : "")
    );
  }
  console.log(`Already sent  : ${deliveredIds.size} people (skipped)`);
  console.log(`Never got link: ${candidates.size} people (gate-stopped + failed)`);
  console.log(`This run      : ${targets.length} (limit ${LIMIT})`);
  console.log(`Mode          : ${SEND ? "SENDING" : "DRY RUN"}`);
  console.log(`Prefix        : ${PREFIX}\n`);

  if (!SEND) {
    for (const [id, info] of targets.slice(0, 20)) {
      console.log(`  @${info.commenterName ?? id}`);
    }
    if (targets.length > 20) console.log(`  ... and ${targets.length - 20} more`);
    console.log("\nRe-run with --send to deliver.");
    return;
  }

  let sent = 0;
  const failures = new Map<string, number>();
  // Once the window has closed it has closed for everyone in the batch, so a
  // run of consecutive "outside of allowed window" refusals means the rest are
  // hopeless too. Stop rather than spend hundreds of requests proving it.
  const WINDOW_SUBCODE = "2534022";
  const GIVE_UP_AFTER = 10;
  let consecutiveWindowRefusals = 0;

  for (const [userId, info] of targets) {
    try {
      if (automation.trackedLinks.length > 0) {
        const bodyText = `${PREFIX}\n\n${
          renderMessageWithoutLink({
            message: automation.dmMessage,
            commenterName: info.commenterName,
          }) || "İşte linkin:"
        }`;
        const buttons = automation.trackedLinks.slice(0, 3).map((link, index) => ({
          url: buildTrackedUrl(link.slug),
          title:
            (index === 0 ? automation.linkButtonLabel : link.label) ||
            link.label ||
            "Open link",
        }));
        await sendDirectMessageWithLinkButton(
          accessToken,
          automation.instagramAccount.instagramId,
          userId,
          bodyText,
          buttons,
          { humanAgent: HUMAN_AGENT }
        );
      } else {
        await sendDirectMessage(
          accessToken,
          automation.instagramAccount.instagramId,
          userId,
          `${PREFIX}\n\n${renderMessageWithTracking({
            message: automation.dmMessage,
            commenterName: info.commenterName,
            trackedLinks: automation.trackedLinks,
          })}`,
          { humanAgent: HUMAN_AGENT }
        );
      }

      // Record it as a reveal, so the dashboard reflects reality and a second
      // run skips them. It must be the `reveal:` row: that is what marks the
      // link as delivered, and a gate-stopped person has no FAILED row to
      // update — without this they would be messaged again on every run.
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId: `reveal:${userId}`,
          },
        },
        create: {
          workspaceId: automation.workspaceId,
          automationId: automation.id,
          instagramAccountId: automation.instagramAccountId,
          commenterId: userId,
          commenterName: info.commenterName,
          commentText: "(manual resend)",
          commentId: `reveal:${userId}`,
          status: "SENT",
          dmSentAt: new Date(),
          errorMessage: "Delivered by the manual resend script",
        },
        update: {
          status: "SENT",
          dmSentAt: new Date(),
          errorMessage: "Delivered by the manual resend script",
        },
      });

      sent++;
      consecutiveWindowRefusals = 0;
      console.log(`  ✓ @${info.commenterName ?? userId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const subcode = message.match(/sub=(\d+)/)?.[1] ?? "other";
      failures.set(subcode, (failures.get(subcode) ?? 0) + 1);
      console.log(`  ✗ @${info.commenterName ?? userId} — ${message.slice(0, 90)}`);

      consecutiveWindowRefusals =
        subcode === WINDOW_SUBCODE ? consecutiveWindowRefusals + 1 : 0;
      if (consecutiveWindowRefusals >= GIVE_UP_AFTER) {
        console.log(
          `\nStopping: ${GIVE_UP_AFTER} consecutive sends refused as outside the ` +
            `24-hour window. These conversations cannot be reopened from here.`
        );
        break;
      }
    }

    // Meta allows 750 private replies an hour; plain DMs are not the same
    // bucket, but pacing keeps this well clear of any throttle.
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }

  console.log(`\nDelivered: ${sent} / ${targets.length}`);
  if (failures.size > 0) {
    console.log("Refused:");
    for (const [subcode, count] of [...failures].sort((a, b) => b[1] - a[1])) {
      console.log(`  sub=${subcode}: ${count}`);
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
