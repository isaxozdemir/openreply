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
 * Deliveries are recorded before Redis processing. Older deployments recorded
 * only at the end, so a runtime timeout could leave no row at all. A zero count
 * therefore does not prove Meta never delivered the interaction: also inspect
 * the web host's request/error logs for timeouts, 401s and connection failures.
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
  recipient?: { id?: string };
  read?: unknown;
  postback?: { payload?: string; mid?: string };
  message?: {
    text?: string;
    is_echo?: boolean;
    quick_reply?: { payload?: string };
  };
};

async function main() {
  const hours = Number(arg("hours") ?? 24);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error("--hours must be a positive number");
  }
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
  let echoes = 0;
  let reads = 0;
  let quickReplies = 0;
  const inboundRows: { at: Date; account: string; user: string; text: string }[] = [];
  const relevantDeliveries = new Set<(typeof events)[number]>();
  const postbackRows: { at: Date; user: string; payload: string; status: string }[] =
    [];

  for (const event of events) {
    const payload = event.payload as {
      entry?: { id?: string; messaging?: Messaging[]; changes?: { field?: string }[] }[];
    };

    for (const entry of payload?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field === "comments") comments++;
      }
      for (const messaging of entry.messaging ?? []) {
        if (messaging.postback) {
          postbacks++;
          relevantDeliveries.add(event);
          postbackRows.push({
            at: event.createdAt,
            user: messaging.sender?.id ?? "?",
            payload: messaging.postback.payload ?? "(no payload)",
            status: event.status,
          });
        }
        if (messaging.read) reads++;
        if (messaging.message) {
          const account = entry.id ?? messaging.recipient?.id;
          if (messaging.message.is_echo || (account && messaging.sender?.id === account)) {
            echoes++;
          } else {
            messages++;
            if (messaging.message.quick_reply) quickReplies++;
            relevantDeliveries.add(event);
            inboundRows.push({
              at: event.createdAt,
              account: account ?? "?",
              user: messaging.sender?.id ?? "?",
              text: messaging.message.text ?? "(no text)",
            });
          }
        }
      }
    }
  }

  console.log(`Webhook deliveries in the last ${hours}h: ${events.length}\n`);
  console.log(`  comment events  : ${comments}`);
  console.log(`  inbound messages: ${messages}`);
  console.log(`  outgoing echoes : ${echoes}`);
  console.log(`  read receipts   : ${reads}`);
  console.log(`  quick replies   : ${quickReplies}`);
  console.log(`  BUTTON TAPS     : ${postbacks}`);

  const failed = events.filter((e) => e.status === "FAILED");
  if (failed.length > 0) {
    console.log(`\n  ${failed.length} delivery/deliveries FAILED to process:`);
    for (const f of failed.slice(0, 5)) {
      console.log(`    ${f.createdAt.toISOString()}  ${f.errorMessage ?? ""}`);
    }
  }

  const pending = events.filter((e) => e.status === "PENDING");
  if (pending.length > 0) {
    console.log(`\n  ${pending.length} delivery/deliveries PENDING: processing has not finished.`);
  }
  console.log("\n  Also check Vercel request/error logs: older deployments did not persist deliveries before enqueueing, so runtime timeouts left no database row.");

  if (postbacks === 0) {
    console.log("\n  No postback objects were recorded in this time window.");
    if (messages === 0) {
      console.log(
        "  No inbound DMs were recorded either. Outgoing echoes and read receipts\n" +
        "  do NOT demonstrate that user messages are reaching the app. Check app\n" +
        "  publishing/access status and messaging permissions as well as the\n" +
        "  app-level and account-level webhook subscriptions. This count alone\n" +
        "  does not identify which setting or delivery stage is responsible."
      );
    } else {
      console.log(
        "  Inbound DMs did arrive. Inspect their text and quick_reply payloads\n" +
        "  before concluding the button interaction was never delivered."
      );
    }
  } else {
    console.log(`\n  Taps received:`);
    for (const row of postbackRows.slice(0, 20)) {
      console.log(
        `    ${row.at.toISOString()}  user ${row.user}  ${row.payload}  [${row.status}]`
      );
    }
    console.log(
      `\n  These reached the webhook. PENDING/FAILED means enqueueing or\n` +
        `  processing did not finish; check Vercel/Redis first. For PROCESSED\n` +
        `  deliveries, check the queue and DmLog for these users.`
    );
  }

  if (inboundRows.length > 0) {
    console.log("\n  Recent inbound messages:");
    for (const row of inboundRows.slice(0, 15)) {
      console.log(`    ${row.at.toISOString()} account ${row.account} user ${row.user} ${JSON.stringify(row.text)}`);
    }
  }

  if (raw) {
    const selected = [...relevantDeliveries].slice(0, 10);
    console.log("\n--- raw inbound / postback payloads ---");
    if (selected.length === 0) {
      console.log("No inbound/postback payloads. Showing the last 3 other deliveries for context:");
      selected.push(...events.slice(0, 3));
    }
    for (const event of selected) {
      console.log(`\n${event.createdAt.toISOString()} [${event.status}]`);
      console.log(JSON.stringify(event.payload, null, 2));
    }
  }

  await prisma.$disconnect();
  process.exit(0);
}

void main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
