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

  it("writes the webhook row once, attributed and never UPDATEd", async () => {
    await POST(signedRequest(commentBurst(100)));

    // The old code inserted PENDING then UPDATEd the same row once per event
    // to set the same workspaceId, turning one insert into a hundred writes.
    expect(mockPrisma.webhookEvent.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.webhookEvent.update).not.toHaveBeenCalled();
    expect(mockPrisma.webhookEvent.create.mock.calls[0][0].data.workspaceId).toBe(
      "workspace_1"
    );
  });

  it("records the delivery as PROCESSED, not PENDING", async () => {
    await POST(signedRequest(commentBurst(10)));

    const data = mockPrisma.webhookEvent.create.mock.calls[0][0].data;
    expect(data.status).toBe("PROCESSED");
    expect(data.processedAt).toBeInstanceOf(Date);
  });

  it("finishes the write before responding", async () => {
    // Marking the row after the response is not guaranteed to run to
    // completion in a serverless or container runtime — that is what stranded
    // rows at PENDING in production. Hold the write open and assert the
    // handler is still waiting on it.
    let settle: () => void = () => {};
    mockPrisma.webhookEvent.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = () => resolve({ id: "we_1" });
        })
    );

    let responded = false;
    const pending = POST(signedRequest(commentBurst(5))).then((r) => {
      responded = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(responded).toBe(false);

    settle();
    const response = await pending;
    expect(response.status).toBe(200);
  });

  it("records a failed delivery as FAILED with the reason", async () => {
    mockQueue.addBulk.mockRejectedValue(new Error("redis unavailable"));

    const response = await POST(signedRequest(commentBurst(5)));

    expect(response.status).toBe(500);
    const data = mockPrisma.webhookEvent.create.mock.calls[0][0].data;
    expect(data.status).toBe("FAILED");
    expect(data.errorMessage).toContain("redis unavailable");
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

  it("keys a postback on Meta's message id", async () => {
    await POST(
      signedRequest({
        object: "instagram",
        entry: [
          {
            id: "ig_account_1",
            messaging: [
              {
                sender: { id: "user_1" },
                recipient: { id: "ig_account_1" },
                postback: { mid: "m_abc", payload: "followcheck:auto_1" },
              },
            ],
          },
        ],
      })
    );

    const jobs = mockQueue.addBulk.mock.calls[0][0];
    expect(jobs[0].opts.jobId).toBe("postback_ig_account_1_user_1_m_abc");
  });

  it("lets a postback with no message id through unkeyed", async () => {
    // Falling back to the payload gave every tap by the same user on the same
    // campaign an identical jobId, and BullMQ silently drops an add that
    // collides with a retained job — so tapping "i'm following" a second time,
    // after actually following, did nothing at all.
    await POST(
      signedRequest({
        object: "instagram",
        entry: [
          {
            id: "ig_account_1",
            messaging: [
              {
                sender: { id: "user_1" },
                recipient: { id: "ig_account_1" },
                postback: { payload: "followcheck:auto_1" },
              },
            ],
          },
        ],
      })
    );

    const jobs = mockQueue.addBulk.mock.calls[0][0];
    expect(jobs[0].opts.jobId).toBeUndefined();
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
