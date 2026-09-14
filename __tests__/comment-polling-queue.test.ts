import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, add, comments } = vi.hoisted(() => ({
  db: {
    automation: { findMany: vi.fn() },
    dmLog: { findMany: vi.fn() },
    adMediaMapping: { findMany: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  add: vi.fn(),
  comments: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/queue/client", () => ({ getDMQueue: () => ({ add }) }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "test-token" }));
vi.mock("@/lib/meta/client", () => ({
  getRecentMediaComments: comments, getUserMedia: vi.fn(), MetaApiError: class extends Error {},
}));
import { reconcileComments } from "@/lib/polling/comment-reconciler";

beforeEach(() => {
  vi.clearAllMocks();
  db.automation.findMany.mockResolvedValue([{
    id: "automation_1", workspaceId: "workspace_1", name: "Programs",
    postId: "post_1", matchAnyPost: false, matchAnyWord: false,
    keywords: ["program"], wholeWordMatch: true, publicReplyEnabled: true,
    instagramAccount: { id: "account_row", instagramId: "ig_account_1", username: "owner", accessToken: "encrypted" },
  }]);
  db.adMediaMapping.findMany.mockResolvedValue([]);
  db.dmLog.findMany.mockResolvedValue([]);
  db.operationalEvent.create.mockResolvedValue({});
  comments.mockResolvedValue([{
    id: "comment_0", text: "program", timestamp: new Date().toISOString(),
    from: { id: "person_1", username: "person" },
  }]);
});

describe("polling queue coordination", () => {
  it("uses the webhook's deduplication key while keeping fresh job IDs for later public reply retries", async () => {
    await reconcileComments();
    expect(add).toHaveBeenCalledWith("process-comment", expect.objectContaining({
      instagramAccountId: "ig_account_1", commentId: "comment_0", source: "POLLING",
    }), { deduplication: { id: "comment_ig_account_1_comment_0" } });
  });

  it("does not enqueue a fully handled comment", async () => {
    db.dmLog.findMany.mockResolvedValue([{ commentId: "comment_0" }]);
    await reconcileComments();
    expect(add).not.toHaveBeenCalled();
  });
});
