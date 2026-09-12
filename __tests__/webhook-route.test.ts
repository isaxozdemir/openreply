/**
 * Webhook route — burst behavior.
 *
 * Meta batches many changes into one delivery and expects a fast 200; a slow
 * response is retried, and every retry used to insert another full-payload row.
 * These tests pin the property that matters: the work done before responding
 * must not grow with the number of events in the delivery.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";

const { mockPrisma, mockQueue } = vi.hoisted(() => ({
  mockPrisma: {
    webhookEvent: { create: vi.fn(), update: vi.fn() },
    instagramAccount: { findUnique: vi.fn(), findMany: vi.fn() },
    dmLog: { findMany: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  mockQueue: { add: vi.fn(), addBulk: vi.fn() },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => mockQueue,
  MESSAGE_JOB_NAME: "process-message",
  POSTBACK_JOB_NAME: "process-postback",
  FOLLOWUP_JOB_NAME: "process-followup",
}));

import { POST } from "@/app/api/webhook/route";

const SECRET = "test_app_secret_12345";

function signedRequest(payload: unknown) {
  const body = JSON.stringify(payload);
  const signature =
    "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
  return new Request("https://example.com/api/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": signature },
    body,
  }) as unknown as Parameters<typeof POST>[0];
}

/** A delivery carrying `count` comments, all on one account. */
function commentBurst(count: number) {
  return {
    object: "instagram",
    entry: [
      {
        id: "ig_account_1",
        time: Date.now(),
        changes: Array.from({ length: count }, (_, i) => ({
          field: "comments",
          value: {
            id: `comment_${i}`,
            text: "LINK",
            from: { id: `user_${i}`, username: `user${i}` },
            media: { id: "media_1" },
          },
        })),
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FACEBOOK_APP_SECRET", SECRET);
  mockPrisma.webhookEvent.create.mockResolvedValue({ id: "we_1" });
  mockPrisma.webhookEvent.update.mockResolvedValue({});
  mockPrisma.instagramAccount.findMany.mockResolvedValue([
    { instagramId: "ig_account_1", workspaceId: "workspace_1" },
  ]);
  mockPrisma.dmLog.findMany.mockResolvedValue([]);
  mockPrisma.operationalEvent.create.mockResolvedValue({});
  mockQueue.addBulk.mockResolvedValue([]);
});

describe("webhook route under a burst", () => {
  it("responds 200", async () => {
    const response = await POST(signedRequest(commentBurst(50)));
    expect(response.status).toBe(200);
  });

  it("looks accounts up once, not once per comment", async () => {
    await POST(signedRequest(commentBurst(100)));

    expect(mockPrisma.instagramAccount.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.instagramAccount.findMany).toHaveBeenCalledTimes(1);
  });

  it("enqueues every comment in a single bulk call", async () => {
    await POST(signedRequest(commentBurst(100)));

    expect(mockQueue.add).not.toHaveBeenCalled();
    expect(mockQueue.addBulk).toHaveBeenCalledTimes(1);
    expect(mockQueue.addBulk.mock.calls[0][0]).toHaveLength(100);
  });

  it("keeps deterministic job ids so Meta's retries stay deduped", async () => {
    await POST(signedRequest(commentBurst(3)));

    const jobs = mockQueue.addBulk.mock.calls[0][0];
    expect(jobs.map((j: { opts: { jobId: string } }) => j.opts.jobId)).toEqual([
      "comment_ig_account_1_comment_0",
      "comment_ig_account_1_comment_1",
      "comment_ig_account_1_comment_2",
    ]);
  });

  it("writes the webhook row once, attributed at insert time", async () => {
    await POST(signedRequest(commentBurst(100)));

    // The old code UPDATEd this one row once per event to set the same
    // workspaceId, turning one insert into a hundred serial writes.
    expect(mockPrisma.webhookEvent.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.webhookEvent.create.mock.calls[0][0].data.workspaceId).toBe(
      "workspace_1"
    );
  });

  it("does not block the response on the PROCESSED update", async () => {
    await POST(signedRequest(commentBurst(10)));

    // It may still be written, just not awaited before the 200.
    const blockingUpdates = mockPrisma.webhookEvent.update.mock.calls.filter(
      (call) => call[0].data?.status === "PROCESSED"
    );
    expect(blockingUpdates.length).toBeLessThanOrEqual(1);
  });

  it("does the same number of pre-response queries for 1 and 200 comments", async () => {
    await POST(signedRequest(commentBurst(1)));
    const small =
      mockPrisma.instagramAccount.findMany.mock.calls.length +
      mockPrisma.webhookEvent.create.mock.calls.length +
      mockQueue.addBulk.mock.calls.length;

    vi.clearAllMocks();
    mockPrisma.webhookEvent.create.mockResolvedValue({ id: "we_2" });
    mockPrisma.instagramAccount.findMany.mockResolvedValue([
      { instagramId: "ig_account_1", workspaceId: "workspace_1" },
    ]);
    mockQueue.addBulk.mockResolvedValue([]);

    await POST(signedRequest(commentBurst(200)));
    const large =
      mockPrisma.instagramAccount.findMany.mock.calls.length +
      mockPrisma.webhookEvent.create.mock.calls.length +
      mockQueue.addBulk.mock.calls.length;

    expect(large).toBe(small);
  });

  it("rejects an unsigned delivery", async () => {
    const response = await POST(
      new Request("https://example.com/api/webhook", {
        method: "POST",
        body: JSON.stringify(commentBurst(1)),
      }) as unknown as Parameters<typeof POST>[0]
    );

    expect(response.status).toBe(401);
    expect(mockQueue.addBulk).not.toHaveBeenCalled();
  });
});
