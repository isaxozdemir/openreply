/**
 * Check — and optionally repair — which webhook fields an account is subscribed
 * to.
 *
 * The one that matters is `messaging_postbacks`: it carries button taps. Without
 * it the opening DM's button and the follow prompt's button fire nothing. The
 * person taps, no webhook arrives, no job is queued, and the link is never sent
 * — with no error anywhere, because from the app's side nothing happened at all.
 *
 * The subscribe call in lib/meta/client.ts asked for only ["comments",
 * "messages"] until this was found, and the subscription is made once when the
 * account is connected. So fixing the code does not fix an account that is
 * already connected: it has to be re-subscribed, which is what --fix does.
 *
 * Usage:
 *   npx tsx scripts/check-webhook-fields.ts
 *   ... --fix     re-subscribe every account with the full field list
 */

import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { getMetaGraphApiVersion } from "@/lib/env";
import { subscribeInstagramAccountToWebhooks } from "@/lib/meta/client";

const REQUIRED = ["comments", "messages", "messaging_postbacks"];

async function main() {
  const fix = process.argv.includes("--fix");

  const accounts = await prisma.instagramAccount.findMany({
    select: {
      id: true,
      username: true,
      instagramId: true,
      accessToken: true,
    },
  });

  for (const account of accounts) {
    console.log(`\n=== @${account.username} (${account.instagramId}) ===`);

    let accessToken: string;
    try {
      accessToken = decryptToken(account.accessToken);
    } catch {
      console.log("  could not decrypt the stored token — skipping");
      continue;
    }

    const url = new URL(
      `https://graph.instagram.com/${getMetaGraphApiVersion()}/${account.instagramId}/subscribed_apps`
    );
    url.searchParams.set("access_token", accessToken);

    const response = await fetch(url.toString());
    const body = await response.text();

    if (!response.ok) {
      console.log(`  could not read subscription: HTTP ${response.status} ${body.slice(0, 200)}`);
      continue;
    }

    const parsed = JSON.parse(body) as {
      data?: { subscribed_fields?: string[] }[];
    };
    const subscribed = parsed.data?.[0]?.subscribed_fields ?? [];

    console.log(`  subscribed: ${subscribed.join(", ") || "(none)"}`);

    const missing = REQUIRED.filter((f) => !subscribed.includes(f));
    if (missing.length === 0) {
      console.log("  ✓ nothing missing");
      continue;
    }

    console.log(`  ✗ MISSING: ${missing.join(", ")}`);
    if (missing.includes("messaging_postbacks")) {
      console.log(
        "    button taps are not being delivered — the link can never be sent"
      );
    }

    if (!fix) {
      console.log("    re-run with --fix to subscribe");
      continue;
    }

    try {
      await subscribeInstagramAccountToWebhooks(
        account.instagramId,
        accessToken
      );
      console.log("    re-subscribed; re-run without --fix to confirm");
    } catch (error) {
      console.log(
        `    re-subscribe failed: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  await prisma.$disconnect();
  process.exit(0);
}

void main();
