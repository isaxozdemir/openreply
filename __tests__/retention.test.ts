import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecuteRaw } = vi.hoisted(() => ({
  mockExecuteRaw: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: { $executeRaw: mockExecuteRaw },
}));

import { pruneExpiredRecords, RETENTION_DAYS } from "@/lib/ops/retention";

/**
 * The raw queries are tagged templates, so the values land in the params array.
 * Pull the cutoff Date back out to assert on the window each table was swept
 * with — the table name lives in the static strings.
 */
function callsFor(table: string) {
  return mockExecuteRaw.mock.calls.filter((call) => {
    const strings = call[0] as unknown as string[];
    return strings.join("").includes(`"${table}"`);
  });
}

function cutoffOf(call: unknown[]): Date {
  return call[1] as Date;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecuteRaw.mockResolvedValue(0);
});

describe("retention sweep", () => {
  it("sweeps every append-only table", async () => {
    await pruneExpiredRecords();

    for (const table of [
      "WebhookEvent",
      "OperationalEvent",
      "LinkClick",
      "DmLog",
    ]) {
      expect(callsFor(table).length).toBeGreaterThan(0);
    }
  });

  it("applies each table's own retention window", async () => {
    const now = new Date("2026-09-12T00:00:00.000Z");
    await pruneExpiredRecords(now);

    const day = 24 * 60 * 60 * 1000;
    const expected: [string, number][] = [
      ["WebhookEvent", RETENTION_DAYS.webhookEvent],
      ["OperationalEvent", RETENTION_DAYS.operationalEvent],
      ["LinkClick", RETENTION_DAYS.linkClick],
      ["DmLog", RETENTION_DAYS.dmLog],
    ];

    for (const [table, days] of expected) {
      const cutoff = cutoffOf(callsFor(table)[0]);
      expect(cutoff.getTime()).toBe(now.getTime() - days * day);
    }
  });

  it("keeps sending batches while a table is still full, then stops", async () => {
    // Two full batches, then a short one — the short batch ends the loop.
    mockExecuteRaw
      .mockResolvedValueOnce(5_000)
      .mockResolvedValueOnce(5_000)
      .mockResolvedValueOnce(12)
      .mockResolvedValue(0);

    const deleted = await pruneExpiredRecords(new Date(), 5_000);

    expect(deleted.webhookEvent).toBe(10_012);
    expect(callsFor("WebhookEvent").length).toBe(3);
  });

  it("caps a single run so one invocation cannot sweep unbounded", async () => {
    mockExecuteRaw.mockResolvedValue(5_000);

    await pruneExpiredRecords(new Date(), 5_000);

    // Whatever remains is picked up by the next scheduled run rather than
    // holding one very long transaction now.
    expect(callsFor("WebhookEvent").length).toBe(40);
  });

  it("reports what it deleted per table", async () => {
    mockExecuteRaw.mockResolvedValue(3);

    const deleted = await pruneExpiredRecords();

    expect(deleted).toEqual({
      webhookEvent: 3,
      operationalEvent: 3,
      linkClick: 3,
      dmLog: 3,
    });
  });
});
