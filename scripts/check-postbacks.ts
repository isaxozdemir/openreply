/**
 * Did Meta actually deliver the button taps?
 *
 * When a tap produces nothing, there are only three possibilities, and they
 * need completely different fixes:
 *
 *   1. No webhook arrived at all        → subscription, or Meta not sending
 *   2. It arrived but queued no job     → parsing, or a dropped duplicate id
 *   3. It queued a job that failed      → the worker; look in DmLog
 *
 * Every delivery is stored in WebhookEvent with its raw payload, so this reads
 * them back and says which case applies. A postback payload contains
 * `postback`, and its `payload` field is the button's own value
 * (`followcheck:<id>` or `reveal:<id>`).
 *
 * Read-only.
 *
 * Usage:
 *   npx tsx scripts/check-postbacks.ts
 *   ... --hours 6     how far back to look (default 24)
 *   ... --raw         print the full payload of each postback found
 */

import { prisma } from "@/lib/db/client";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

type Messaging = {
  sender?: { id?: string };
  postback?: { payload?: string; mid?: string };
  message?: unknown;
};

async function main() {
  const hours = Number(arg("hours") ?? 24);
  const raw = process.argv.includes("--raw");
  const since = new Date(Date.now() - hours * 3_600_000);

  const events = await prisma.webhookEvent.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    select: {
      createdAt: true,
      object: true,
      status: true,
      errorMessage: true,
      payload: true,
    },
  });

  let comments = 0;
  let messages = 0;
  let postbacks = 0;
  const postbackRows: { at: Date; user: string; payload: string; status: string }[] =
    [];

  for (const event of events) {
    const payload = event.payload as {
      entry?: { messaging?: Messaging[]; changes?: unknown[] }[];
    };

    for (const entry of payload?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        void change;
        comments++;
      }
      for (const messaging of entry.messaging ?? []) {
        if (messaging.postback) {
          postbacks++;
          postbackRows.push({
            at: event.createdAt,
            user: messaging.sender?.id ?? "?",
            payload: messaging.postback.payload ?? "(no payload)",
            status: event.status,
          });
        } else if (messaging.message) {
          messages++;
        }
      }
    }
  }

  console.log(`Webhook deliveries in the last ${hours}h: ${events.length}\n`);
  console.log(`  comment events  : ${comments}`);
  console.log(`  message events  : ${messages}`);
  console.log(`  BUTTON TAPS     : ${postbacks}`);

  const failed = events.filter((e) => e.status === "FAILED");
  if (failed.length > 0) {
    console.log(`\n  ${failed.length} delivery/deliveries FAILED to process:`);
    for (const f of failed.slice(0, 5)) {
      console.log(`    ${f.createdAt.toISOString()}  ${f.errorMessage ?? ""}`);
    }
  }

  if (postbacks === 0) {
    console.log(
      `\n  No button taps arrived.\n` +
        `  The app never saw them, so nothing downstream could have run. Check\n` +
        `  that messaging_postbacks is subscribed for THIS app (Meta dashboard →\n` +
        `  Webhooks → Instagram), and that the account was connected after it\n` +
        `  was enabled — the per-account subscription is made once, at connect.`
    );
  } else {
    console.log(`\n  Taps received:`);
    for (const row of postbackRows.slice(0, 20)) {
      console.log(
        `    ${row.at.toISOString()}  user ${row.user}  ${row.payload}  [${row.status}]`
      );
    }
    console.log(
      `\n  These reached the app. If the link still did not arrive, the\n` +
        `  problem is after this point — check DmLog for these users.`
    );
  }

  if (raw) {
    console.log(`\n--- raw payloads ---`);
    for (const event of events.slice(0, 10)) {
      console.log(`\n${event.createdAt.toISOString()} [${event.status}]`);
      console.log(JSON.stringify(event.payload, null, 2).slice(0, 1500));
    }
  }

  await prisma.$disconnect();
  process.exit(0);
}

void main();
