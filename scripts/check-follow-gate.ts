/**
 * Diagnose the follow gate against the live Meta API.
 *
 * The symptom this exists for: a user who demonstrably follows the account taps
 * "i'm following", and the gate re-prompts them instead of delivering the link.
 * From the worker logs alone it is impossible to tell whether Meta answered
 * "no", answered nothing, or refused the call — getUserFollowStatus collapses
 * all three into `null`/`false`.
 *
 * This prints the RAW response, so the actual cause is visible:
 *
 *   - HTTP 400 with an OAuth error  -> the call is being refused (permission,
 *     token, or the field is not available to this app)
 *   - HTTP 200 without the field    -> consent precondition not met; Meta only
 *     populates is_user_follow_business once the user has messaged the account,
 *     tapped an icebreaker, or used the persistent menu
 *   - HTTP 200 with false           -> Meta genuinely says "not following",
 *     which for a real follower means the value lags behind the follow
 *
 * It also sends the token both ways (Authorization header vs access_token query
 * parameter). getUserFollowStatus is the ONLY GET in lib/meta/client.ts that
 * uses the header; every other read uses the query parameter. If the two
 * disagree, that difference is the bug.
 *
 * Usage:
 *   npx tsx scripts/check-follow-gate.ts --account <instagramAccountId>
 *   ... --user <IGSID>        check one specific person
 *   ... --recent 10           check the last N people who hit the gate
 */

import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { getMetaGraphApiVersion } from "@/lib/env";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

type Probe = {
  label: string;
  status: number;
  body: string;
};

async function probe(
  recipientId: string,
  accessToken: string,
  mode: "header" | "query"
): Promise<Probe> {
  const url = new URL(
    `https://graph.instagram.com/${getMetaGraphApiVersion()}/${recipientId}`
  );
  url.searchParams.set("fields", "is_user_follow_business,name,username");
  if (mode === "query") url.searchParams.set("access_token", accessToken);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers:
        mode === "header"
          ? { Authorization: `Bearer ${accessToken}` }
          : undefined,
    });
    return {
      label: mode === "header" ? "Authorization header" : "access_token query",
      status: response.status,
      body: (await response.text()).slice(0, 500),
    };
  } catch (error) {
    return {
      label: mode === "header" ? "Authorization header" : "access_token query",
      status: 0,
      body: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const accountArg = arg("account");
  const userArg = arg("user");
  const recent = Number(arg("recent") ?? 10);

  const account = accountArg
    ? await prisma.instagramAccount.findFirst({
        where: { OR: [{ id: accountArg }, { instagramId: accountArg }] },
      })
    : await prisma.instagramAccount.findFirst({
        orderBy: { updatedAt: "desc" },
      });

  if (!account?.accessToken) {
    console.error("No Instagram account with a stored token. Pass --account.");
    process.exit(1);
  }

  console.log(
    `Account: ${account.username ?? "(no username)"} (instagramId ${account.instagramId})`
  );

  let accessToken: string;
  try {
    accessToken = decryptToken(account.accessToken);
  } catch (error) {
    console.error(
      "Could not decrypt the stored token — ENCRYPTION_KEY likely differs from the one that wrote it:",
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  }

  // Does the token work at all for a plain read? If this fails, nothing below
  // means anything — the problem is the token, not the follow field.
  const meUrl = new URL(
    `https://graph.instagram.com/${getMetaGraphApiVersion()}/me`
  );
  meUrl.searchParams.set("fields", "id,user_id,username");
  meUrl.searchParams.set("access_token", accessToken);
  const meResponse = await fetch(meUrl.toString());
  console.log(
    `\nToken sanity check (/me): HTTP ${meResponse.status} ${(await meResponse.text()).slice(0, 300)}`
  );

  let userIds: string[];
  if (userArg) {
    userIds = [userArg];
  } else {
    // People the gate actually blocked are not recorded as such, so fall back
    // to whoever most recently interacted with this account.
    const logs = await prisma.dmLog.findMany({
      where: { instagramAccountId: account.id },
      orderBy: { createdAt: "desc" },
      take: recent,
      select: { commenterId: true, commenterName: true, status: true },
    });
    userIds = [...new Set(logs.map((l) => l.commenterId))];
    console.log(
      `\nNo --user given; probing the ${userIds.length} most recent interactions.`
    );
  }

  for (const userId of userIds) {
    console.log(`\n--- IGSID ${userId} ---`);
    for (const mode of ["header", "query"] as const) {
      const result = await probe(userId, accessToken, mode);
      console.log(`  ${result.label}: HTTP ${result.status} ${result.body}`);
    }
  }

  await prisma.$disconnect();
}

void main();
