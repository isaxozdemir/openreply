import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockPrisma,
  mockSendPrivateReply,
  mockSendCommentReply,
  mockSendPrivateReplyWithLinkButton,
  mockSendPrivateReplyWithButton,
  mockGetUserFollowStatus,
  mockSendDirectMessageWithButton,
  mockSendDirectMessage,
  mockSendDirectMessageWithLinkButton,
  mockDecryptToken,
  mockMatchKeywords,
  mockReserveDMSlot,
  mockReleaseDMSlot,
  mockQueueAdd,
  mockReserveWorkspaceDMSend,
  mockReleaseWorkspaceDMReservation,
} = vi.hoisted(() => ({
  mockPrisma: {
    automation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    dmLog: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    instagramAccount: {
      findUnique: vi.fn(),
    },
    operationalEvent: {
      create: vi.fn(),
    },
  },
  mockSendPrivateReply: vi.fn(),
  mockSendCommentReply: vi.fn(),
  mockSendPrivateReplyWithLinkButton: vi.fn(),
  mockSendPrivateReplyWithButton: vi.fn(),
  mockGetUserFollowStatus: vi.fn(),
  mockSendDirectMessageWithButton: vi.fn(),
  mockSendDirectMessage: vi.fn(),
  mockSendDirectMessageWithLinkButton: vi.fn(),
  mockDecryptToken: vi.fn(),
  mockMatchKeywords: vi.fn(),
  mockReserveDMSlot: vi.fn(),
  mockReleaseDMSlot: vi.fn(),
  mockQueueAdd: vi.fn(),
  mockReserveWorkspaceDMSend: vi.fn(),
  mockReleaseWorkspaceDMReservation: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/meta/client", () => ({
  // Must match the real constant in lib/meta/client.ts — the worker compares
  // against it by value.
  FOLLOW_STATUS_NO_CONSENT: "no_consent",
  sendPrivateReply: mockSendPrivateReply,
  sendPrivateReplyWithLinkButton: mockSendPrivateReplyWithLinkButton,
  sendPrivateReplyWithButton: mockSendPrivateReplyWithButton,
  getUserFollowStatus: mockGetUserFollowStatus,
  sendDirectMessageWithButton: mockSendDirectMessageWithButton,
  sendDirectMessage: mockSendDirectMessage,
  sendDirectMessageWithLinkButton: mockSendDirectMessageWithLinkButton,
  sendCommentReply: mockSendCommentReply,
  MetaApiError: class MetaApiError extends Error {
    code: number;
    subcode: number | undefined;
    constructor(
      code: number,
      subcode: number | undefined,
      _fbTraceId: string | undefined,
      message: string
    ) {
      super(message);
      this.code = code;
      this.subcode = subcode;
      this.name = "MetaApiError";
    }
  },
  TokenExpiredError: class TokenExpiredError extends Error {
    name = "TokenExpiredError";
  },
  RateLimitError: class RateLimitError extends Error {
    name = "RateLimitError";
  },
}));

vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: mockDecryptToken,
}));

vi.mock("@/lib/utils/keyword-matcher", () => ({
  matchKeywords: mockMatchKeywords,
}));

vi.mock("@/lib/utils/rate-limiter", () => ({
  reserveDMSlot: mockReserveDMSlot,
  releaseDMSlot: mockReleaseDMSlot,
}));

vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: mockReserveWorkspaceDMSend,
  releaseWorkspaceDMReservation: mockReleaseWorkspaceDMReservation,
}));

vi.mock("@/lib/ops/worker-health", () => ({
  recordWorkerAlert: vi.fn(),
}));

vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({
    add: mockQueueAdd,
  }),
  getRedisConnection: vi.fn(),
  POSTBACK_JOB_NAME: "process-postback",
  FOLLOWUP_JOB_NAME: "process-followup",
  MESSAGE_JOB_NAME: "process-message",
  RECOVERY_JOB_NAME: "process-dm-recovery",
}));

vi.mock("bullmq", () => {
  function MockWorker(_name: string, processor: unknown) {
    (global as Record<string, unknown>).__dmWorkerProcessor = processor;
    return {
      on: vi.fn(),
      close: vi.fn(),
    };
  }
  // Mirrors BullMQ's real class: an ordinary Error subclass the queue treats as
  // "do not retry". Tests assert on the message, which it preserves.
  class MockUnrecoverableError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = "UnrecoverableError";
    }
  }
  return {
    Worker: MockWorker,
    DelayedError: class extends Error { constructor() { super("bullmq:movedToDelayed"); } },
    UnrecoverableError: MockUnrecoverableError,
  };
});

import { createDMWorker } from "../lib/queue/dm-worker";

const usagePeriodStart = new Date("2026-05-01T00:00:00.000Z");

const mockAutomation = {
  id: "auto_789",
  workspaceId: "workspace_123",
  instagramAccountId: "ig_account_row_1",
  postId: "media_101",
  keywords: ["LINK", "PRICE"],
  dmMessage: "Hey {username}! Here is the link: https://example.com",
  isActive: true,
  wholeWordMatch: true,
  matchAnyPost: false,
  matchAnyWord: false,
  openingDmEnabled: false,
  openingDmMessage: null,
  openingDmButtonLabel: null,
  linkButtonLabel: null,
  dmTriggerEnabled: false,
  dmRecoveryEnabled: false,
  dmRecoveryMessage: "Mesaj ulaşmadıysa bana DM’den {keyword} yaz.",
  publicReplyEnabled: false,
  publicReplyMessage: null,
  publicReplyMessages: [],
  instagramAccount: {
    id: "ig_account_row_1",
    instagramId: "ig_456",
    accessToken: "encrypted_token_abc",
  },
  workspace: {
    id: "workspace_123",
  },
  trackedLinks: [],
};

const mockJobData = {
  instagramAccountId: "ig_456",
  commentId: "comment_555",
  commentText: "I want the LINK!",
  commenterId: "commenter_999",
  commenterName: "commenter_user",
  mediaId: "media_101",
};

function getProcessor(): (job: {
  name?: string;
  data: typeof mockJobData | Record<string, unknown>;
  id: string;
  attemptsMade: number;
}) => Promise<void> {
  createDMWorker();
  return (global as Record<string, unknown>).__dmWorkerProcessor as (job: {
    name?: string;
    data: typeof mockJobData | Record<string, unknown>;
    id: string;
    attemptsMade: number;
  }) => Promise<void>;
}

function createMockJob(data: Record<string, unknown> = mockJobData) {
  return {
    data,
    id: "job_001",
    attemptsMade: 0,
    opts: { attempts: 3 },
    token: "worker-token",
    updateData: vi.fn().mockResolvedValue(undefined),
    moveToDelayed: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockPostbackJob(
  data: Record<string, unknown> = {
    instagramAccountId: "ig_456",
    userId: "commenter_999",
    payload: "reveal:auto_789",
  }
) {
  return {
    name: "process-postback",
    data,
    id: "postback_job_001",
    attemptsMade: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  mockPrisma.automation.findMany.mockResolvedValue([mockAutomation]);
  mockPrisma.automation.findFirst.mockResolvedValue(null);
  mockPrisma.dmLog.findUnique.mockResolvedValue(null);
  mockPrisma.dmLog.create.mockResolvedValue({});
  // Two different lookups share findFirst: the cross-campaign private-reply
  // check (keyed on status SENT) and the postback's name lookup. Only the
  // latter should resolve by default, or every comment would look like a
  // duplicate of an already-answered one.
  mockPrisma.dmLog.findFirst.mockImplementation(
    async (args: { where?: { status?: string } } = {}) =>
      args.where?.status === "SENT" ? null : { commenterName: "commenter_user" }
  );
  mockPrisma.dmLog.upsert.mockResolvedValue({});
  mockPrisma.dmLog.update.mockResolvedValue({});
  mockPrisma.instagramAccount.findUnique.mockResolvedValue({
    workspaceId: "workspace_123",
  });
  mockPrisma.operationalEvent.create.mockResolvedValue({});
  mockDecryptToken.mockReturnValue("decrypted_token");
  mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });
  mockReserveWorkspaceDMSend.mockResolvedValue({
    allowed: true,
    reserved: true,
    remaining: 100,
    limit: 2000,
    periodStart: usagePeriodStart,
  });
  mockReserveDMSlot.mockResolvedValue({
    allowed: true,
    currentCount: 11,
    remainingDMs: 179,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: true,
  });
  mockReleaseDMSlot.mockResolvedValue(10);
  mockReleaseWorkspaceDMReservation.mockResolvedValue({ count: 1 });
  mockSendPrivateReply.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_001",
  });
  mockSendPrivateReplyWithLinkButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_002",
  });
  mockSendPrivateReplyWithButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_003",
  });
  mockSendDirectMessageWithButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_004",
  });
  mockSendDirectMessage.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_005",
  });
  mockSendDirectMessageWithLinkButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_006",
  });
  mockGetUserFollowStatus.mockResolvedValue(true);
});

describe("DM Worker — comments left on an ad", () => {
  it("also matches the organic post the ad was created from", async () => {
    const processor = getProcessor();

    // A boosted post: the comment carries the ad's media id, while the
    // campaign is bound to the post the ad was made from. Without the second
    // id in the query the comment matches nothing and is dropped silently.
    await processor(
      createMockJob({
        ...mockJobData,
        mediaId: "ad_media_999",
        originalMediaId: "media_101",
      })
    );

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { postId: "ad_media_999" },
            { postId: "media_101" },
            { matchAnyPost: true },
          ],
        }),
      })
    );
    expect(mockSendPrivateReply).toHaveBeenCalled();
  });
});

describe("DM Worker — Full Pipeline", () => {
  it("should send a private reply for a matching comment", async () => {
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ postId: "media_101" }, { matchAnyPost: true }],
        isActive: true,
        instagramAccount: { instagramId: "ig_456" },
      },
      include: {
        instagramAccount: true,
        workspace: true,
        trackedLinks: {
          select: {
            slug: true,
            label: true,
            destinationUrl: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    expect(mockMatchKeywords).toHaveBeenCalledWith(
      "I want the LINK!",
      ["LINK", "PRICE"],
      true
    );
    expect(mockReserveWorkspaceDMSend).toHaveBeenCalledWith("workspace_123");
    expect(mockReserveDMSlot).toHaveBeenCalledWith("ig_456", 0);
    expect(mockDecryptToken).toHaveBeenCalledWith("encrypted_token_abc");
    expect(mockSendPrivateReply).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey commenter_user! Here is the link: https://example.com"
    );
    expect(mockReleaseWorkspaceDMReservation).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith({
      where: {
        automationId_commentId: {
          automationId: "auto_789",
          commentId: "comment_555",
        },
      },
      data: expect.objectContaining({ status: "SENT" }),
    });
  });

  it("should skip when no automations match the media", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
  });

  it("should skip when keywords do not match", async () => {
    mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should skip duplicate comments already sent", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({
      id: "existing_log",
      status: "SENT",
    });
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should skip when monthly plan limit is reached", async () => {
    mockReserveWorkspaceDMSend.mockResolvedValue({
      allowed: false,
      reserved: false,
      remaining: 0,
      limit: 100,
      periodStart: usagePeriodStart,
    });

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockReserveDMSlot).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SKIPPED_PLAN_LIMIT" }),
      })
    );
  });

  it("should requeue and release monthly usage when rate limited", async () => {
    mockReserveDMSlot.mockResolvedValue({
      allowed: false,
      currentCount: 190,
      remainingDMs: 0,
      shouldRequeue: true,
      requeueDelayMs: 1800000,
      shouldSkip: false,
      reserved: false,
    });

    const processor = getProcessor();
    const job = createMockJob();
    await expect(processor(job)).rejects.toThrow("bullmq:movedToDelayed");

    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(job.updateData).toHaveBeenCalledWith(expect.objectContaining({ requeueAttempt: 1 }));
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), "worker-token");
  });

  it("should skip with SKIPPED_RATE_LIMIT after max requeue attempts", async () => {
    mockReserveDMSlot.mockResolvedValue({
      allowed: false,
      currentCount: 190,
      remainingDMs: 0,
      shouldRequeue: false,
      requeueDelayMs: 0,
      shouldSkip: true,
      reserved: false,
    });

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SKIPPED_RATE_LIMIT" }),
      })
    );
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should log FAILED, release usage, and re-throw when private reply sending fails", async () => {
    const error = new Error("API Error");
    mockSendPrivateReply.mockRejectedValue(error);

    const processor = getProcessor();

    await expect(processor(createMockJob())).rejects.toThrow("API Error");
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith({
      where: {
        automationId_commentId: {
          automationId: "auto_789",
          commentId: "comment_555",
        },
      },
      data: expect.objectContaining({
        status: "FAILED",
        errorMessage: "API Error",
      }),
    });
  });

  it("should handle missing access token", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        instagramAccount: {
          ...mockAutomation.instagramAccount,
          accessToken: null,
        },
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "FAILED",
          errorMessage: "No Instagram access token available",
        }),
      })
    );
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should use 'there' when commenter name is not available", async () => {
    const processor = getProcessor();
    const jobDataWithoutName = {
      instagramAccountId: mockJobData.instagramAccountId,
      commentId: mockJobData.commentId,
      commentText: mockJobData.commentText,
      commenterId: mockJobData.commenterId,
      mediaId: mockJobData.mediaId,
    };

    await processor(createMockJob(jobDataWithoutName as typeof mockJobData));

    expect(mockSendPrivateReply).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey there! Here is the link: https://example.com"
    );
  });

  it("should deliver tracked links as web_url buttons (one or two)", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        dmMessage: "Hey {username}! Here is the offer: {link}",
        linkButtonLabel: "Get offer",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
          {
            slug: "def456",
            label: "Book a call",
            destinationUrl: "https://example.com/book",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // Primary button title comes from linkButtonLabel; the second from its
    // own stored label. Both point at their tracked /r/<slug> URLs.
    expect(mockSendPrivateReplyWithLinkButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey commenter_user! Here is the offer:",
      [
        { title: "Get offer", url: "http://localhost:3000/r/abc123" },
        { title: "Book a call", url: "http://localhost:3000/r/def456" },
      ]
    );
  });

  it("should send a follow-gate prompt when a non-follower comments", async () => {
    mockGetUserFollowStatus.mockResolvedValue(false); // not following yet
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        requireFollow: true,
        followPromptMessage: "Follow me first {username}, then tap 👇",
        followPromptButtonLabel: "I'm following ✅",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // The follow prompt goes out with a `followcheck:` postback button; the
    // link is NOT delivered yet.
    expect(mockSendPrivateReplyWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Follow me first commenter_user, then tap 👇",
      "I'm following ✅",
      "followcheck:auto_789"
    );
    expect(mockSendPrivateReplyWithLinkButton).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should skip the prompt and send the link when the commenter already follows", async () => {
    mockGetUserFollowStatus.mockResolvedValue(true); // already following
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        requireFollow: true,
        followPromptMessage: "Follow me first, then tap 👇",
        followPromptButtonLabel: "I'm following ✅",
        dmMessage: "Hey {username}! Here is the offer: {link}",
        linkButtonLabel: "Get offer",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // Confirmed follower: no prompt, link delivered right away.
    expect(mockSendPrivateReplyWithButton).not.toHaveBeenCalled();
    expect(mockSendPrivateReplyWithLinkButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey commenter_user! Here is the offer:",
      [{ title: "Get offer", url: "http://localhost:3000/r/abc123" }]
    );
  });

  it("should send the opening DM first (routing to the follow check) when both opening DM and follow-gate are on", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        openingDmEnabled: true,
        openingDmMessage: "Hey {username}, welcome!",
        openingDmButtonLabel: "Get the link",
        requireFollow: true,
        followPromptButtonLabel: "I'm following ✅",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // Opening DM goes out first; its button routes into the follow check.
    expect(mockSendPrivateReplyWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey commenter_user, welcome!",
      "Get the link",
      "followcheck:auto_789"
    );
    // Follow status is verified on the tap, not at comment time.
    expect(mockGetUserFollowStatus).not.toHaveBeenCalled();
    expect(mockSendPrivateReplyWithLinkButton).not.toHaveBeenCalled();
  });

  it("should deliver the next DM from a read fallback when no button tap has sent it yet", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockPrisma.dmLog.findUnique).toHaveBeenCalledWith({
      where: {
        automationId_commentId: {
          automationId: "auto_789",
          commentId: "reveal:commenter_999",
        },
      },
    });
    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      "Hey commenter_user! Here is the link: https://example.com"
    );
  });

  it("should not deliver a read fallback when the button tap already sent the reveal", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });
    mockPrisma.dmLog.findUnique.mockResolvedValue({
      id: "existing_reveal",
      status: "SENT",
    });

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should not let a read fallback bypass the follow gate", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      requireFollow: true,
      trackedLinks: [],
    });
    mockGetUserFollowStatus.mockResolvedValue(false); // still not following

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    // Non-follower on a read fallback: no link, and no re-prompt spam either.
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should deliver a follow-gated read fallback once the user follows", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      requireFollow: true,
      trackedLinks: [],
    });
    mockGetUserFollowStatus.mockResolvedValue(true);

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      "Hey commenter_user! Here is the link: https://example.com"
    );
  });

  it("should not log a failure when a read fallback hits a closed messaging window", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });
    mockSendDirectMessage.mockRejectedValue(
      new Error("This message is sent outside of allowed window.")
    );

    const processor = getProcessor();
    // The window cannot reopen on its own, so this must not throw (no retries)
    // and must not leave a FAILED row the user can do nothing about.
    await expect(
      processor(
        createMockPostbackJob({
          instagramAccountId: "ig_456",
          userId: "commenter_999",
          payload: "reveal:auto_789",
          fallback: true,
        })
      )
    ).resolves.toBeUndefined();

    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalled();
  });

  it("should still log a failure for a real button tap that fails", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });
    mockSendDirectMessage.mockRejectedValue(new Error("boom"));

    const processor = getProcessor();
    await expect(
      processor(
        createMockPostbackJob({
          instagramAccountId: "ig_456",
          userId: "commenter_999",
          payload: "reveal:auto_789",
        })
      )
    ).rejects.toThrow("boom");

    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ status: "FAILED" }),
      })
    );
  });
});

describe("DM Worker — one private reply per comment", () => {
  it("should skip a campaign when another already used the comment's private reply", async () => {
    mockPrisma.dmLog.findFirst.mockImplementation(
      async (args: { where?: { status?: string } } = {}) =>
        args.where?.status === "SENT"
          ? { automation: { name: "openreply 1" } }
          : { commenterName: "commenter_user" }
    );

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SKIPPED_DEDUP",
          errorMessage: expect.stringContaining("openreply 1"),
        }),
      })
    );
  });

  it("should not fall back to a plain-text private reply when the window is the problem", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        trackedLinks: [
          { slug: "abc123", label: null, destinationUrl: "https://example.com" },
        ],
      },
    ]);
    mockSendPrivateReplyWithLinkButton.mockRejectedValue(
      new Error("The comment is invalid for a private reply")
    );

    const processor = getProcessor();
    await expect(processor(createMockJob())).rejects.toThrow(
      "The comment is invalid for a private reply"
    );

    // A text retry on the same comment would fail identically and overwrite the
    // real reason, so it must not be attempted.
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          errorMessage: "The comment is invalid for a private reply",
        }),
      })
    );
  });

  it("should still fall back to plain text when the button template itself is rejected", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        trackedLinks: [
          { slug: "abc123", label: null, destinationUrl: "https://example.com" },
        ],
      },
    ]);
    mockSendPrivateReplyWithLinkButton.mockRejectedValue(
      new Error("Unsupported message template")
    );

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReply).toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SENT" }),
      })
    );
  });
});

describe("DM Worker — DM keyword trigger", () => {
  const dmTriggerAutomation = {
    ...mockAutomation,
    dmTriggerEnabled: true,
    requireFollow: false,
    followPromptMessage: null,
    followPromptButtonLabel: null,
  };

  function createMockMessageJob(data: Record<string, unknown> = {}) {
    return {
      name: "process-message",
      data: {
        instagramAccountId: "ig_456",
        messageId: "mid_abc",
        messageText: "can I get the LINK?",
        senderId: "commenter_999",
        ...data,
      },
      id: "message_job_001",
      attemptsMade: 0,
    };
  }

  beforeEach(() => {
    mockPrisma.automation.findMany.mockResolvedValue([dmTriggerAutomation]);
  });

  it("should reply to a DM whose text matches the campaign keywords", async () => {
    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([{ dmTriggerEnabled: true }]),
          isActive: true,
        }),
      })
    );
    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      "Hey commenter_user! Here is the link: https://example.com"
    );
    // Never a private reply — there is no comment to reply to.
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should not reply when the DM text matches no keyword", async () => {
    mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });

    const processor = getProcessor();
    await processor(createMockMessageJob({ messageText: "hello there" }));

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithLinkButton).not.toHaveBeenCalled();
  });

  it("should log the reply against the inbound message id for dedup", async () => {
    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          automationId_commentId: {
            automationId: "auto_789",
            commentId: "dm:mid_abc",
          },
        },
        create: expect.objectContaining({
          commenterId: "commenter_999",
          commentText: "can I get the LINK?",
          matchedKeyword: "LINK",
          status: "SENT",
        }),
      })
    );
  });

  it("should not re-send when this message was already answered", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({ status: "SENT" });

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should send the link as buttons when the campaign has tracked links", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...dmTriggerAutomation,
        linkButtonLabel: "Get it",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Get it",
            destinationUrl: "https://example.com/offer",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessageWithLinkButton).toHaveBeenCalled();
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("should send the follow prompt instead of the link to a non-follower", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...dmTriggerAutomation, requireFollow: true },
    ]);
    mockGetUserFollowStatus.mockResolvedValue(false);

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessageWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      expect.any(String),
      "I'm following ✅",
      "followcheck:auto_789"
    );
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  // First contact, so the gate is fail-closed like processComment: an
  // unverifiable status must not hand out the link.
  it("should send the follow prompt when follow status cannot be verified", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...dmTriggerAutomation, requireFollow: true },
    ]);
    mockGetUserFollowStatus.mockResolvedValue(null);

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessageWithButton).toHaveBeenCalled();
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("should skip and log when the workspace is over its monthly limit", async () => {
    mockReserveWorkspaceDMSend.mockResolvedValue({
      allowed: false,
      reserved: false,
      remaining: 0,
      limit: 2000,
      periodStart: usagePeriodStart,
    });

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "SKIPPED_PLAN_LIMIT" }),
      })
    );
  });

  it("should release the usage reservation and rethrow when the send fails", async () => {
    mockSendDirectMessage.mockRejectedValue(new Error("Meta is down"));

    const processor = getProcessor();
    await expect(processor(createMockMessageJob())).rejects.toThrow(
      "Meta is down"
    );

    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "FAILED" }),
      })
    );
  });
});

describe("DM Worker — follow gate when Meta will not answer", () => {
  // Meta refuses the profile read with code 230 ("User consent is required")
  // for people who have not messaged the account. It says nothing about whether
  // they follow, so it must not be read as "not following" — doing so traps a
  // real follower in a prompt loop, because tapping the button runs the same
  // refused check again.
  const gatedAutomation = {
    ...mockAutomation,
    requireFollow: true,
    openingDmEnabled: false,
    openingDmMessage: null,
  };

  it("delivers the link on a comment when consent is missing", async () => {
    const { FOLLOW_STATUS_NO_CONSENT } = await import("@/lib/meta/client");
    mockPrisma.automation.findMany.mockResolvedValue([gatedAutomation]);
    mockGetUserFollowStatus.mockResolvedValue(FOLLOW_STATUS_NO_CONSENT);

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReply).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      expect.any(String),
      "Hey commenter_user! Here is the link: https://example.com"
    );
    // The follow prompt is for an answered "no", not for an unanswerable check.
    expect(mockSendPrivateReplyWithButton).not.toHaveBeenCalled();
  });

  it("still prompts on a comment when Meta answers that they do not follow", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([gatedAutomation]);
    mockGetUserFollowStatus.mockResolvedValue(false);

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockSendPrivateReplyWithButton).toHaveBeenCalled();
  });

  it("delivers the link on a DM trigger when consent is missing", async () => {
    const { FOLLOW_STATUS_NO_CONSENT } = await import("@/lib/meta/client");
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...gatedAutomation, dmTriggerEnabled: true },
    ]);
    mockGetUserFollowStatus.mockResolvedValue(FOLLOW_STATUS_NO_CONSENT);

    const processor = getProcessor();
    await processor({
      name: "process-message",
      data: {
        instagramAccountId: "ig_456",
        messageId: "mid_consent",
        messageText: "can I get the LINK?",
        senderId: "commenter_999",
      },
      id: "message_job_consent",
      attemptsMade: 0,
    });

    expect(mockSendDirectMessage).toHaveBeenCalled();
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
  });

  it("still prompts on a DM trigger when Meta answers that they do not follow", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...gatedAutomation, dmTriggerEnabled: true },
    ]);
    mockGetUserFollowStatus.mockResolvedValue(false);

    const processor = getProcessor();
    await processor({
      name: "process-message",
      data: {
        instagramAccountId: "ig_456",
        messageId: "mid_notfollowing",
        messageText: "can I get the LINK?",
        senderId: "commenter_999",
      },
      id: "message_job_notfollowing",
      attemptsMade: 0,
    });

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithButton).toHaveBeenCalled();
  });
});

describe("DM Worker — a blocked follow gate leaves a record", () => {
  it("writes a SKIPPED_FOLLOW_GATE row under its own key, not the reveal key", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      requireFollow: true,
    });
    mockGetUserFollowStatus.mockResolvedValue(false);

    const processor = getProcessor();
    await processor({
      name: "process-postback",
      data: {
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:automation_123",
      },
      id: "postback_gate",
      attemptsMade: 0,
    });

    // The prompt goes out again...
    expect(mockSendDirectMessageWithButton).toHaveBeenCalled();
    // ...and the block is recorded, so the person is no longer invisible.
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          automationId_commentId: expect.objectContaining({
            commentId: "gate:commenter_999",
          }),
        }),
        create: expect.objectContaining({
          status: "SKIPPED_FOLLOW_GATE",
        }),
      })
    );
  });
});

describe("DM Worker — retry budget and rate-limit slots", () => {
  it("stops retrying when Meta reports a permanently undeliverable send", async () => {
    const { MetaApiError } = await import("@/lib/meta/client");
    mockSendPrivateReply.mockRejectedValue(
      new MetaApiError(
        100,
        2534025,
        "trace",
        "The comment is invalid for a private reply"
      )
    );

    const processor = getProcessor();
    const error = await processor(createMockJob()).catch((e) => e);

    // UnrecoverableError is what tells BullMQ to skip the remaining attempts.
    // Without it each dead comment burns three attempts and three slots.
    expect(error.name).toBe("UnrecoverableError");
    expect(error.message).toContain("invalid for a private reply");
  });

  it("does not claim delivery when Meta rejects a private-reply retry", async () => {
    const { MetaApiError } = await import("@/lib/meta/client");
    mockSendPrivateReply.mockRejectedValue(
      new MetaApiError(
        100,
        2534025,
        "trace",
        "The comment is invalid for a private reply"
      )
    );

    const processor = getProcessor();
    // A retry rejection does not prove that the first message arrived.
    await processor({ ...createMockJob(), attemptsMade: 1 }).catch(() => {});

    const logged = mockPrisma.dmLog.update.mock.calls.at(-1)?.[0];
    expect(logged.data.status).toBe("FAILED");
    expect(logged.data.errorMessage).toContain("delivery from earlier attempts is unconfirmed");
    expect(logged.data.errorMessage).not.toContain("already delivered");
  });

  it("does not add that note on a first-attempt rejection", async () => {
    const { MetaApiError } = await import("@/lib/meta/client");
    mockSendPrivateReply.mockRejectedValue(
      new MetaApiError(
        100,
        2534025,
        "trace",
        "The comment is invalid for a private reply"
      )
    );

    const processor = getProcessor();
    // No prior attempt, so nothing of ours could have consumed the reply.
    await processor(createMockJob()).catch(() => {});

    const logged = mockPrisma.dmLog.update.mock.calls.at(-1)?.[0];
    expect(logged.data.errorMessage).not.toContain("already delivered");
    expect(logged.data.errorMessage).not.toContain("earlier attempts");
  });

  it("stops retrying once the 24-hour messaging window has closed", async () => {
    const { MetaApiError } = await import("@/lib/meta/client");
    mockSendPrivateReply.mockRejectedValue(
      new MetaApiError(
        100,
        2534022,
        "trace",
        "This message is sent outside of allowed window."
      )
    );

    const processor = getProcessor();
    const error = await processor(createMockJob()).catch((e) => e);

    // The window counts from the person's last message to the account and
    // cannot be reopened from our side, so retrying only burns attempts.
    expect(error.name).toBe("UnrecoverableError");
  });

  it("keeps retrying a transient Meta outage", async () => {
    const { MetaApiError } = await import("@/lib/meta/client");
    mockSendPrivateReply.mockRejectedValue(
      new MetaApiError(2, 1545133, "trace", "Service temporarily unavailable")
    );

    const processor = getProcessor();
    const error = await processor(createMockJob()).catch((e) => e);

    expect(error.name).not.toBe("UnrecoverableError");
    expect(error.message).toContain("Service temporarily unavailable");
  });

  it("returns the hourly Instagram slot when a send fails", async () => {
    mockSendPrivateReply.mockRejectedValue(new Error("Meta is down"));

    const processor = getProcessor();
    await expect(processor(createMockJob())).rejects.toThrow("Meta is down");

    // The slot was reserved before the send; nothing was delivered, so the
    // account's 750/hour capacity must not be consumed by the failure.
    expect(mockReleaseDMSlot).toHaveBeenCalledWith("ig_456");
  });

  it("does not return a slot that was never reserved", async () => {
    mockReserveDMSlot.mockResolvedValue({
      allowed: false,
      currentCount: 750,
      remainingDMs: 0,
      shouldRequeue: false,
      requeueDelayMs: 0,
      shouldSkip: true,
      reserved: false,
    });

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockReleaseDMSlot).not.toHaveBeenCalled();
  });

  it("keeps the slot when the send succeeds", async () => {
    mockSendPrivateReply.mockResolvedValue({
      recipient_id: "r",
      message_id: "m",
    });

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockReleaseDMSlot).not.toHaveBeenCalled();
  });
});

describe("DM Worker — failed private reply recovery", () => {
  const recoveryAutomation = {
    ...mockAutomation,
    dmRecoveryEnabled: true,
    publicReplyEnabled: true,
  };
  const failure = {
    status: "FAILED",
    errorMessage: "Meta API Error 100: invalid for a private reply [sub=2534025]",
    matchedKeyword: "LINK",
    attempts: 1,
    recoveryCommentSentAt: null,
    publicReplySentAt: new Date(),
  };
  const recoveryJob = () => ({
    ...createMockJob({
      instagramAccountId: "ig_456",
      automationId: "auto_789",
      commentId: "comment_555",
    }),
    name: "process-dm-recovery",
  });
  const messageJob = () => ({
    ...createMockJob({
      instagramAccountId: "ig_456",
      messageId: "recovery_inbound_1",
      messageText: "LINK",
      senderId: "commenter_999",
    }),
    name: "process-message",
  });

  beforeEach(() => {
    mockPrisma.automation.findMany.mockResolvedValue([recoveryAutomation]);
    mockPrisma.automation.findFirst.mockResolvedValue(recoveryAutomation);
    mockSendCommentReply.mockResolvedValue({ id: "reply_1" });
  });

  it("schedules a recovery comment after a permanent private reply rejection", async () => {
    const { MetaApiError } = await import("@/lib/meta/client");
    mockSendPrivateReply.mockRejectedValue(new MetaApiError(100, 2534025, undefined, failure.errorMessage));
    await expect(getProcessor()(createMockJob())).rejects.toThrow("invalid for a private reply");
    expect(mockQueueAdd).toHaveBeenCalledWith("process-dm-recovery", {
      instagramAccountId: "ig_456", automationId: "auto_789", commentId: "comment_555",
    }, expect.objectContaining({ jobId: "recovery_ig_456_comment_555", delay: 10000 }));
  });

  it("does not send plain text immediately after a transient button failure", async () => {
    const { MetaApiError } = await import("@/lib/meta/client");
    mockPrisma.automation.findMany.mockResolvedValue([{
      ...recoveryAutomation, openingDmEnabled: true,
      openingDmMessage: "Tap below", openingDmButtonLabel: "Send",
    }]);
    mockSendPrivateReplyWithButton.mockRejectedValue(new MetaApiError(2, 1545133, undefined, "Service temporarily unavailable"));
    await expect(getProcessor()(createMockJob())).rejects.toThrow("Service temporarily unavailable");
    expect(mockSendPrivateReplyWithButton).toHaveBeenCalledTimes(1);
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("schedules recovery when transient private reply attempts are exhausted", async () => {
    const { MetaApiError } = await import("@/lib/meta/client");
    mockSendPrivateReply.mockRejectedValue(new MetaApiError(2, 1545133, undefined, "Service temporarily unavailable"));
    const job = createMockJob();
    job.attemptsMade = 2;
    await expect(getProcessor()(job)).rejects.toThrow();
    expect(mockQueueAdd).toHaveBeenCalledWith("process-dm-recovery", expect.anything(), expect.anything());
  });

  it("does not re-send a terminal private reply when polling enqueues it again", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue(failure);
    await getProcessor()(createMockJob());
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReserveDMSlot).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledWith("process-dm-recovery", expect.anything(), expect.anything());
  });

  it("posts the requested instruction without marking the failed DM sent", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue(failure);
    await getProcessor()(recoveryJob());
    expect(mockSendCommentReply).toHaveBeenCalledWith("decrypted_token", "comment_555", "Mesaj ulaşmadıysa bana DM’den LINK yaz.");
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith({
      where: { automationId_commentId: { automationId: "auto_789", commentId: "comment_555" } },
      data: { recoveryCommentSentAt: expect.any(Date), recoveryCommentError: null },
    });
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it.each([
    { ...failure, recoveryCommentSentAt: new Date() },
    { ...failure, status: "SENT" },
    { ...failure, errorMessage: "The requested user cannot be found [sub=2534014]" },
  ])("does not post an instruction for an already handled or ineligible record %#", async (log) => {
    mockPrisma.dmLog.findUnique.mockResolvedValue(log);
    await getProcessor()(recoveryJob());
    expect(mockSendCommentReply).not.toHaveBeenCalled();
  });

  it("does not recover an inactive/disabled campaign or a different account", async () => {
    mockPrisma.automation.findFirst.mockResolvedValueOnce(null);
    await getProcessor()(recoveryJob());
    expect(mockPrisma.automation.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ isActive: true, dmRecoveryEnabled: true, publicReplyEnabled: true }),
    }));
    mockPrisma.automation.findFirst.mockResolvedValueOnce({ ...recoveryAutomation, instagramAccount: { ...mockAutomation.instagramAccount, instagramId: "other_account" } });
    await getProcessor()(recoveryJob());
    expect(mockSendCommentReply).not.toHaveBeenCalled();
  });

  it("records recovery comment errors separately from the original DM failure", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue(failure);
    mockSendCommentReply.mockRejectedValue(new Error("Public comment request failed"));
    await expect(getProcessor()(recoveryJob())).rejects.toThrow("Public comment request failed");
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { recoveryCommentError: "Public comment request failed" },
    }));
  });

  it("resumes a recent failed campaign from an inbound keyword with general DM triggers off", async () => {
    mockPrisma.dmLog.findFirst.mockResolvedValue(failure);
    await getProcessor()(messageJob());
    expect(mockPrisma.dmLog.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        automationId: "auto_789", commenterId: "commenter_999", status: "FAILED",
        commentId: { not: { contains: ":" } }, createdAt: { gte: expect.any(Date) },
      }),
    }));
    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ instagramAccount: { instagramId: "ig_456" } }),
    }));
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it.each([null, { errorMessage: "No Instagram access token available" }])("ignores an inbound keyword without an eligible recent failure %#", async (record) => {
    mockPrisma.dmLog.findFirst.mockResolvedValue(record);
    await getProcessor()(messageJob());
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockReserveDMSlot).not.toHaveBeenCalled();
  });

  it("ignores unrelated inbound text even when a failure exists", async () => {
    mockPrisma.dmLog.findFirst.mockResolvedValue(failure);
    mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });
    await getProcessor()(messageJob());
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("preserves the follow gate during recovery", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([{
      ...recoveryAutomation, requireFollow: true,
      followPromptMessage: "Follow first", followPromptButtonLabel: "Check",
    }]);
    mockPrisma.dmLog.findFirst.mockResolvedValue(failure);
    mockGetUserFollowStatus.mockResolvedValue(false);
    await getProcessor()(messageJob());
    expect(mockSendDirectMessageWithButton).toHaveBeenCalledTimes(1);
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithLinkButton).not.toHaveBeenCalled();
  });

  it("does not recover the same inbound message twice", async () => {
    mockPrisma.dmLog.findFirst.mockResolvedValue(failure);
    mockPrisma.dmLog.findUnique.mockResolvedValue({ status: "SENT" });
    await getProcessor()(messageJob());
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });
});
