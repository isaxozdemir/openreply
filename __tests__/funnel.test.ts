import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRedis } = vi.hoisted(() => ({
  mockRedis: {
    incr: vi.fn(),
    expire: vi.fn(),
    mget: vi.fn(),
  },
}));

vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => mockRedis,
}));

import { recordFunnelStage, getFunnel } from "@/lib/ops/funnel";

const ACCOUNT = "ig_123";
const NOW = new Date("2026-09-12T10:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  mockRedis.incr.mockResolvedValue(5);
  mockRedis.expire.mockResolvedValue(1);
  mockRedis.mget.mockResolvedValue([]);
});

describe("funnel counters", () => {
  it("counts a stage against the account and day", async () => {
    await recordFunnelStage(ACCOUNT, "received", NOW);

    expect(mockRedis.incr).toHaveBeenCalledWith(
      "funnel:ig_123:2026-09-12:received"
    );
  });

  it("sets an expiry only when the counter is created", async () => {
    mockRedis.incr.mockResolvedValueOnce(1);
    await recordFunnelStage(ACCOUNT, "received", NOW);
    expect(mockRedis.expire).toHaveBeenCalledTimes(1);

    mockRedis.incr.mockResolvedValueOnce(2);
    await recordFunnelStage(ACCOUNT, "received", NOW);
    // Still one — re-setting the TTL on every comment would keep the key alive
    // forever under sustained traffic.
    expect(mockRedis.expire).toHaveBeenCalledTimes(1);
  });

  it("never throws — a counter must not cost a delivery", async () => {
    mockRedis.incr.mockRejectedValue(new Error("redis down"));
    await expect(
      recordFunnelStage(ACCOUNT, "received", NOW)
    ).resolves.toBeUndefined();
  });

  it("reads a window of days, oldest first", async () => {
    mockRedis.mget.mockResolvedValue([
      "100", "80", "12",
      "200", "150", "30",
    ]);

    const funnel = await getFunnel(ACCOUNT, 2, NOW);

    expect(funnel).toEqual([
      { date: "2026-09-11", received: 100, campaignMatched: 80, keywordMatched: 12 },
      { date: "2026-09-12", received: 200, campaignMatched: 150, keywordMatched: 30 },
    ]);
  });

  it("treats a missing day as zero rather than dropping it", async () => {
    mockRedis.mget.mockResolvedValue([null, null, null]);

    const funnel = await getFunnel(ACCOUNT, 1, NOW);

    expect(funnel).toEqual([
      { date: "2026-09-12", received: 0, campaignMatched: 0, keywordMatched: 0 },
    ]);
  });

  it("returns nothing readable when Redis is unavailable", async () => {
    mockRedis.mget.mockRejectedValue(new Error("redis down"));
    await expect(getFunnel(ACCOUNT, 7, NOW)).resolves.toEqual([]);
  });
});
