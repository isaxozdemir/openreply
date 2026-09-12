import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockPrisma, mockRecordWorkerAlert, capturedHandlers } = vi.hoisted(
  () => ({
    mockPrisma: {
      operationalEvent: { createMany: vi.fn(), create: vi.fn() },
      instagramAccount: { findUnique: vi.fn() },
    },
    mockRecordWorkerAlert: vi.fn(),
    capturedHandlers: new Map<string, (...args: unknown[]) => void>(),
  })
);

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/ops/worker-health", () => ({
  recordWorkerAlert: mockRecordWorkerAlert,
}));
vi.mock("bullmq", () => ({
  UnrecoverableError: class extends Error {},
  Worker: class {
    on(event: string, handler: (...args: unknown[]) => void) {
      capturedHandlers.set(event, handler);
      return this;
    }
    close() {}
  },
}));
vi.mock("@/lib/meta/client", () => ({
  MetaApiError: class extends Error {},
  RateLimitError: class extends Error {},
  TokenExpiredError: class extends Error {},
  getUserFollowStatus: vi.fn(),
  sendCommentReply: vi.fn(),
  sendDirectMessage: vi.fn(),
  sendDirectMessageWithButton: vi.fn(),
  sendDirectMessageWithLinkButton: vi.fn(),
  sendPrivateReply: vi.fn(),
  sendPrivateReplyWithButton: vi.fn(),
  sendPrivateReplyWithLinkButton: vi.fn(),
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: vi.fn() }));
vi.mock("@/lib/utils/keyword-matcher", () => ({ matchKeywords: vi.fn() }));
vi.mock("@/lib/utils/rate-limiter", () => ({
  reserveDMSlot: vi.fn(),
  releaseDMSlot: vi.fn(),
}));
vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: vi.fn(),
  releaseWorkspaceDMReservation: vi.fn(),
}));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: vi.fn(),
  getRedisConnection: vi.fn(),
  MESSAGE_JOB_NAME: "process-message",
  POSTBACK_JOB_NAME: "process-postback",
  FOLLOWUP_JOB_NAME: "process-followup",
}));

import { createDMWorker, drainWorkerFailures } from "@/lib/queue/dm-worker";

function failJob(jobId: string, accountId: string, message: string) {
  const handler = capturedHandlers.get("failed");
  if (!handler) throw new Error("worker never registered a failed handler");
  return handler(
    { id: jobId, data: { instagramAccountId: accountId }, attemptsMade: 1 },
    new Error(message)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedHandlers.clear();
  mockPrisma.instagramAccount.findUnique.mockResolvedValue({
    workspaceId: "workspace_1",
  });
  mockPrisma.operationalEvent.createMany.mockResolvedValue({ count: 1 });
  createDMWorker();
});

afterEach(async () => {
  await drainWorkerFailures();
});

describe("worker failure aggregation", () => {
  it("does not write a row per failure", async () => {
    for (let i = 0; i < 500; i++) {
      await failJob(`job_${i}`, "ig_1", "The comment is invalid");
    }

    // Writing one row per failure is what grew OperationalEvent to hundreds of
    // thousands of rows and filled the database volume.
    expect(mockPrisma.operationalEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.operationalEvent.createMany).not.toHaveBeenCalled();
  });

  it("collapses identical failures into one counted row", async () => {
    for (let i = 0; i < 500; i++) {
      await failJob(`job_${i}`, "ig_1", "The comment is invalid");
    }

    await drainWorkerFailures();

    expect(mockPrisma.operationalEvent.createMany).toHaveBeenCalledTimes(1);
    const rows = mockPrisma.operationalEvent.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain("500 jobs failed");
    expect(rows[0].payload.count).toBe(500);
  });

  it("keeps distinct reasons and accounts apart", async () => {
    await failJob("a", "ig_1", "reason one");
    await failJob("b", "ig_1", "reason two");
    await failJob("c", "ig_2", "reason one");

    await drainWorkerFailures();

    const rows = mockPrisma.operationalEvent.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(3);
  });

  it("still records every failure to the bounded Redis alert list", async () => {
    await failJob("a", "ig_1", "boom");
    await failJob("b", "ig_1", "boom");

    // That list is capped at 25 entries in Redis, so it costs nothing on disk
    // and stays useful as a live feed.
    expect(mockRecordWorkerAlert).toHaveBeenCalledTimes(2);
  });

  it("writes nothing when there were no failures", async () => {
    await drainWorkerFailures();
    expect(mockPrisma.operationalEvent.createMany).not.toHaveBeenCalled();
  });

  it("clears the buffer after flushing so counts do not double", async () => {
    await failJob("a", "ig_1", "boom");
    await drainWorkerFailures();
    await drainWorkerFailures();

    expect(mockPrisma.operationalEvent.createMany).toHaveBeenCalledTimes(1);
  });
});
