/**
 * Comment reconciliation — ad copies of a boosted post.
 *
 * Comments left on an ad carry the ad's own media id, so the sweep has to look
 * at those media too or a webhook Meta never delivers is lost for good.
 *
 * The pairing used to be recovered by unnesting every retained WebhookEvent
 * payload on each sweep. It is now recorded when the comment arrives, so the
 * lookup is indexed and the mapping outlives the raw payloads.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    adMediaMapping: { findMany: vi.fn(), upsert: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { adMediaFor, recordAdMedia } from "../lib/polling/comment-reconciler";

const POST = "18023946917554990";
const AD = "17899788633163100";

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.adMediaMapping.upsert.mockResolvedValue({});
});

describe("adMediaFor", () => {
  it("returns the ad media ids seen for the post", async () => {
    mockPrisma.adMediaMapping.findMany.mockResolvedValue([{ mediaId: AD }]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("never returns the post itself, so it is not swept twice", async () => {
    mockPrisma.adMediaMapping.findMany.mockResolvedValue([
      { mediaId: AD },
      { mediaId: POST },
    ]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("returns nothing when the post was never boosted", async () => {
    mockPrisma.adMediaMapping.findMany.mockResolvedValue([]);
    await expect(adMediaFor(POST)).resolves.toEqual([]);
  });

  it("queries by the organic post id", async () => {
    mockPrisma.adMediaMapping.findMany.mockResolvedValue([]);
    await adMediaFor(POST);

    expect(mockPrisma.adMediaMapping.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { originalMediaId: POST } })
    );
  });

  it("swallows a query failure, leaving the post itself still swept", async () => {
    mockPrisma.adMediaMapping.findMany.mockRejectedValue(
      new Error("connection lost")
    );
    await expect(adMediaFor(POST)).resolves.toEqual([]);
  });
});

describe("recordAdMedia", () => {
  it("stores the pairing idempotently", async () => {
    await recordAdMedia(POST, AD);

    expect(mockPrisma.adMediaMapping.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { originalMediaId_mediaId: { originalMediaId: POST, mediaId: AD } },
        create: { originalMediaId: POST, mediaId: AD },
      })
    );
  });

  it("ignores a comment that is not on an ad", async () => {
    // Same id on both sides means the comment landed on the organic post.
    await recordAdMedia(POST, POST);
    expect(mockPrisma.adMediaMapping.upsert).not.toHaveBeenCalled();
  });

  it("ignores an incomplete pairing", async () => {
    await recordAdMedia("", AD);
    await recordAdMedia(POST, "");
    expect(mockPrisma.adMediaMapping.upsert).not.toHaveBeenCalled();
  });

  it("never throws into the caller — delivery matters more than the mapping", async () => {
    mockPrisma.adMediaMapping.upsert.mockRejectedValue(new Error("db down"));
    await expect(recordAdMedia(POST, AD)).resolves.toBeUndefined();
  });
});
