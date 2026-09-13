import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getDMQueue } from "@/lib/queue/client";
import {
  parseCommentEvents,
  parseMessageEvents,
  parsePostbackEvents,
  parseReadEvents,
  verifyWebhookSignature,
} from "@/lib/meta/webhook";
import { MESSAGE_JOB_NAME, POSTBACK_JOB_NAME } from "@/lib/queue/client";
import { recordAdMedia } from "@/lib/polling/comment-reconciler";
import { Prisma } from "@/app/generated/prisma/client";

const OPENING_DM_READ_FALLBACK_DELAY_MS = 5 * 60 * 1000;

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json(
    { success: false, error: "Verification failed" },
    { status: 403 }
  );
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!verifyWebhookSignature(rawBody, signature)) {
    // Record the attempt so a signature mismatch is visible rather than a
    // silent 401. This is the common symptom of FACEBOOK_APP_SECRET being
    // set to the wrong app's secret for the webhook's signing key.
    await prisma.operationalEvent
      .create({
        data: {
          source: "SYSTEM",
          level: "WARNING",
          message: "Webhook signature verification failed",
          payload: {
            hadSignatureHeader: Boolean(signature),
            bodyLength: rawBody.length,
            bodyPreview: rawBody.slice(0, 200),
          },
        },
      })
      .catch(() => {});
    return NextResponse.json(
      { success: false, error: "Invalid signature" },
      { status: 401 }
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }

  const commentEvents = parseCommentEvents(
    payload as Parameters<typeof parseCommentEvents>[0]
  );
  const postbackEvents = parsePostbackEvents(
    payload as Parameters<typeof parsePostbackEvents>[0]
  );
  const messageEvents = parseMessageEvents(
    payload as Parameters<typeof parseMessageEvents>[0]
  );
  const readEvents = parseReadEvents(
    payload as Parameters<typeof parseReadEvents>[0]
  );

  // Resolve every account the delivery touches in one query. Meta batches many
  // changes into a single delivery and they are almost always for the same
  // account, so the previous per-event findUnique re-fetched one identical row
  // dozens of times — all of it serial, all of it before Meta gets its 200.
  const accountIds = [
    ...new Set(
      [...commentEvents, ...messageEvents, ...postbackEvents, ...readEvents].map(
        (e) => e.instagramAccountId
      )
    ),
  ];
  const accounts =
    accountIds.length > 0
      ? await prisma.instagramAccount.findMany({
          where: { instagramId: { in: accountIds } },
          select: { instagramId: true, workspaceId: true },
        })
      : [];
  // A delivery belongs to one workspace in practice — Meta sends one entry per
  // account. Attribute the row at insert time instead of UPDATEing it once per
  // event; if a delivery ever did span workspaces, leave it unattributed rather
  // than claim the wrong one.
  const workspaceIds = [...new Set(accounts.map((a) => a.workspaceId))];
  const workspaceId = workspaceIds.length === 1 ? workspaceIds[0] : null;

  const objectType =
    typeof payload === "object" && payload && "object" in payload
      ? String(payload.object)
      : null;

  // Persist before touching Redis. A runtime timeout cannot run our catch
  // block; writing only at the end made delivered button taps disappear from
  // diagnostics whenever enqueueing stalled. PENDING means processing did not
  // finish, not that Meta never delivered the event.
  const delivery = await prisma.webhookEvent.create({
    data: {
      workspaceId,
      object: objectType,
      payload: payload as Prisma.InputJsonValue,
      status: "PENDING",
    },
  });

  // Await the outcome update before responding, including on failure.
  const recordDelivery = (
    status: "PROCESSED" | "FAILED",
    errorMessage?: string
  ) =>
    prisma.webhookEvent.update({
      where: { id: delivery.id },
      data: {
        status,
        errorMessage: errorMessage ?? null,
        processedAt: new Date(),
      },
    });

  try {
    const queue = getDMQueue();

    // Every job for this delivery goes to Redis in one pipelined call rather
    // than one round trip per event.
    const jobs: Parameters<ReturnType<typeof getDMQueue>["addBulk"]>[0] = [];

    for (const event of commentEvents) {
      jobs.push({
        name: "process-comment",
        data: {
          instagramAccountId: event.instagramAccountId,
          commentId: event.commentId,
          commentText: event.commentText,
          commenterId: event.commenterId,
          commenterName: event.commenterName,
          mediaId: event.mediaId,
          originalMediaId: event.originalMediaId,
          source: "WEBHOOK",
        },
        opts: {
          jobId: `comment_${event.instagramAccountId}_${event.commentId}`,
        },
      });
    }

    // Button taps from opening DMs → deliver the reveal message.
    for (const event of postbackEvents) {
      jobs.push({
        name: POSTBACK_JOB_NAME,
        data: {
          instagramAccountId: event.instagramAccountId,
          userId: event.userId,
          payload: event.payload,
          mid: event.mid,
        },
        opts: {
          // Deduplicate on Meta's message id, which is unique per tap. Falling
          // back to the payload made the id identical for every tap by the same
          // user on the same campaign — and BullMQ silently drops an add whose
          // jobId matches a retained job, so a second tap did nothing at all.
          // A user who taps "i'm following" again after actually following must
          // get their link, so without a mid we let the job through unkeyed and
          // rely on the handler being idempotent.
          ...(event.mid
            ? {
                jobId: `postback_${event.instagramAccountId}_${
                  event.userId
                }_${event.mid.replace(/:/g, "_")}`,
              }
            : {}),
        },
      });
    }

    // Inbound DMs → keyword-triggered autoreply.
    for (const event of messageEvents) {
      jobs.push({
        name: MESSAGE_JOB_NAME,
        data: {
          instagramAccountId: event.instagramAccountId,
          messageId: event.messageId,
          messageText: event.messageText,
          senderId: event.senderId,
        },
        opts: {
          // Message ids can contain characters BullMQ rejects in a job id (":"
          // in particular). base64url encodes into exactly the allowed alphabet
          // and stays injective — substituting invalid characters would let two
          // distinct mids collapse onto one job id, silently dropping a reply.
          jobId: `message_${event.instagramAccountId}_${Buffer.from(
            event.messageId
          ).toString("base64url")}`,
        },
      });
    }

    // If a user reads the opening DM and never taps the button, deliver the
    // same next-step DM after five minutes. The worker no-ops this delayed job
    // if a real button tap has already delivered the reveal.
    for (const event of readEvents) {
      const openingLogs = await prisma.dmLog.findMany({
        where: {
          commenterId: event.userId,
          status: "SENT",
          automation: {
            isActive: true,
            openingDmEnabled: true,
            instagramAccount: {
              instagramId: event.instagramAccountId,
            },
          },
        },
        select: {
          automation: {
            select: {
              id: true,
            },
          },
        },
      });

      const scheduledAutomationIds = new Set<string>();
      for (const log of openingLogs) {
        const automation = log.automation;
        if (scheduledAutomationIds.has(automation.id)) continue;
        scheduledAutomationIds.add(automation.id);

        jobs.push({
          name: POSTBACK_JOB_NAME,
          data: {
            instagramAccountId: event.instagramAccountId,
            userId: event.userId,
            payload: `reveal:${automation.id}`,
            fallback: true,
          },
          opts: {
            delay: OPENING_DM_READ_FALLBACK_DELAY_MS,
            jobId: `read_fallback_${event.instagramAccountId}_${event.userId}_${automation.id}`,
          },
        });
      }
    }

    if (jobs.length > 0) {
      // One pipelined call, but that also means one failure mode: addBulk is
      // all-or-nothing, so a single bad job takes the whole delivery with it —
      // including a button tap that shared the payload with a comment or read
      // receipt. Name what was lost, since the catch below only records the
      // delivery as FAILED without saying which events it was carrying.
      try {
        await queue.addBulk(jobs);
      } catch (error) {
        const kinds = [
          commentEvents.length && `${commentEvents.length} comment`,
          postbackEvents.length && `${postbackEvents.length} button tap`,
          messageEvents.length && `${messageEvents.length} message`,
        ]
          .filter(Boolean)
          .join(", ");
        console.error(
          `[Webhook] Failed to enqueue ${jobs.length} job(s) (${kinds}):`,
          error instanceof Error ? error.message : error
        );
        throw error;
      }
    }

    // Remember which ads a post was boosted into, so the polling sweep can see
    // comments left on them. Awaited: work started after the response is not
    // guaranteed to run to completion. There is at most one distinct pair per
    // delivery in practice, and recordAdMedia swallows its own failures.
    const adPairs = new Map<string, string>();
    for (const event of commentEvents) {
      if (event.originalMediaId && event.originalMediaId !== event.mediaId) {
        adPairs.set(event.originalMediaId, event.mediaId);
      }
    }
    await Promise.all(
      [...adPairs.entries()].map(([originalMediaId, mediaId]) =>
        recordAdMedia(originalMediaId, mediaId)
      )
    );

    await recordDelivery("PROCESSED");

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await recordDelivery("FAILED", message).catch(() => {});

    return NextResponse.json(
      { success: false, error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}
