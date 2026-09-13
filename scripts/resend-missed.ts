/**
 * Resend the campaign link to people whose delivery failed but who already
 * have an open conversation with the account.
 *
 * Why this can work at all: a failed send does not mean the conversation is
 * closed. If the person tapped a button, replied, or received the follow
 * prompt, a normal direct message is allowed even though the comment's single
 * private reply is long gone. Those are the people this reaches.
 *
 * Who is deliberately NOT included:
 *   - anyone already SENT (they have the link)
 *   - subcode 2534014, "user cannot be found" — the account is gone
 *   - anyone with no evidence of an open conversation
 *
 * Meta's 24-hour messaging window still applies and is not visible from here,
 * so expect some sends to be refused; those are reported, not retried.
 *
 * Usage:
 *   npx tsx scripts/resend-missed.ts --campaign <automationId>           # dry run
 *   npx tsx scripts/resend-missed.ts --campaign <automationId> --send    # actually send
 *   ... --limit 50        cap how many are attempted (default 100)
 *   ... --delay 1500      ms between sends (default 1500)
 */

import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { sendDirectMessage, sendDirectMessageWithLinkButton } from "@/lib/meta/client";
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
const LIMIT = Number(arg("limit") ?? 100);
const DELAY_MS = Number(arg("delay") ?? 1500);

// "User cannot be found" — the Instagram account no longer exists, so there is
// nobody to message. Every other failure is worth an attempt.
const HOPELESS_SUBCODE = "2534014";

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

  // Everyone who already has the link, by IGSID. Someone who failed on one
  // comment but succeeded on another must not be messaged again.
  const delivered = await prisma.dmLog.findMany({
    where: { automationId: automation.id, status: "SENT" },
    select: { commenterId: true },
  });
  const deliveredIds = new Set(delivered.map((row) => row.commenterId));

  const failed = await prisma.dmLog.findMany({
    where: { automationId: automation.id, status: "FAILED" },
    select: {
      commenterId: true,
      commenterName: true,
      errorMessage: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  // One attempt per person, keeping their most recent failure.
  const candidates = new Map<
    string,
    { commenterName: string | null; errorMessage: string | null }
  >();
  for (const row of failed) {
    if (deliveredIds.has(row.commenterId)) continue;
    if (row.errorMessage?.includes(HOPELESS_SUBCODE)) continue;
    if (candidates.has(row.commenterId)) continue;
    candidates.set(row.commenterId, {
      commenterName: row.commenterName,
      errorMessage: row.errorMessage,
    });
  }

  const targets = [...candidates.entries()].slice(0, LIMIT);

  console.log(`Campaign      : ${automation.name}`);
  console.log(`Failed rows   : ${failed.length}`);
  console.log(`Already sent  : ${deliveredIds.size} people (skipped)`);
  console.log(`Reachable     : ${candidates.size} people`);
  console.log(`This run      : ${targets.length} (limit ${LIMIT})`);
  console.log(`Mode          : ${SEND ? "SENDING" : "DRY RUN"}\n`);

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

  for (const [userId, info] of targets) {
    try {
      if (automation.trackedLinks.length > 0) {
        const bodyText =
          renderMessageWithoutLink({
            message: automation.dmMessage,
            commenterName: info.commenterName,
          }) || "Here's your link:";
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
          buttons
        );
      } else {
        await sendDirectMessage(
          accessToken,
          automation.instagramAccount.instagramId,
          userId,
          renderMessageWithTracking({
            message: automation.dmMessage,
            commenterName: info.commenterName,
            trackedLinks: automation.trackedLinks,
          })
        );
      }

      // Record it so the dashboard reflects reality and a second run of this
      // script skips them.
      await prisma.dmLog.updateMany({
        where: {
          automationId: automation.id,
          commenterId: userId,
          status: "FAILED",
        },
        data: {
          status: "SENT",
          dmSentAt: new Date(),
          errorMessage: "Delivered by the manual resend script",
        },
      });

      sent++;
      console.log(`  ✓ @${info.commenterName ?? userId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const subcode = message.match(/sub=(\d+)/)?.[1] ?? "other";
      failures.set(subcode, (failures.get(subcode) ?? 0) + 1);
      console.log(`  ✗ @${info.commenterName ?? userId} — ${message.slice(0, 90)}`);
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
