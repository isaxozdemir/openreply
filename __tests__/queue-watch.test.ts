import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma, mockQueue, mockRecordWorkerAlert } = vi.hoisted(() => ({
  mockPrisma: { operationalEvent: { create: vi.fn() } },
  mockQueue: { getJobCounts: vi.fn() },
  mockRecordWorkerAlert: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/queue/client", () => ({ getDMQueue: () => mockQueue }));
vi.mock("@/lib/ops/worker-health", () => ({
  recordWorkerAlert: mockRecordWorkerAlert,
}));

import {
  checkQueueBacklog,
  resetBacklogAlertState,
  WARN_DEPTH,
  ALARM_DEPTH,
  REALERT_INTERVAL_MS,
} from "@/lib/ops/queue-watch";

const T0 = 1_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  resetBacklogAlertState();
  mockPrisma.operationalEvent.create.mockResolvedValue({});
  mockRecordWorkerAlert.mockResolvedValue(undefined);
});

function counts(waiting: number) {
  mockQueue.getJobCounts.mockResolvedValue({ waiting, active: 5, delayed: 0 });
}

describe("queue backlog watch", () => {
  it("stays quiet while the queue is keeping up", async () => {
    counts(10);
    const report = await checkQueueBacklog(T0);

    expect(report?.level).toBe("ok");
    expect(mockPrisma.operationalEvent.create).not.toHaveBeenCalled();
  });

  it("warns once the backlog is deep enough to risk the reply window", async () => {
    counts(WARN_DEPTH);
    const report = await checkQueueBacklog(T0);

    expect(report?.level).toBe("warning");
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledTimes(1);
    expect(
      mockPrisma.operationalEvent.create.mock.calls[0][0].data.level
    ).toBe("WARNING");
  });

  it("escalates a very deep backlog to an error", async () => {
    counts(ALARM_DEPTH);
    const report = await checkQueueBacklog(T0);

    expect(report?.level).toBe("alarm");
    expect(
      mockPrisma.operationalEvent.create.mock.calls[0][0].data.level
    ).toBe("ERROR");
  });

  it("does not repeat the alert while the same burst drains", async () => {
    counts(ALARM_DEPTH);
    await checkQueueBacklog(T0);
    await checkQueueBacklog(T0 + 60_000);

    // One burst must not produce an alert on every heartbeat — that is the
    // write volume that filled the disk before.
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledTimes(1);
  });

  it("alerts again if the backlog persists past the re-alert interval", async () => {
    counts(ALARM_DEPTH);
    await checkQueueBacklog(T0);
    await checkQueueBacklog(T0 + REALERT_INTERVAL_MS + 1);

    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledTimes(2);
  });

  it("re-arms after the queue recovers", async () => {
    counts(ALARM_DEPTH);
    await checkQueueBacklog(T0);

    counts(0);
    await checkQueueBacklog(T0 + 1000);

    counts(ALARM_DEPTH);
    await checkQueueBacklog(T0 + 2000);

    // A fresh burst is news even if the previous one was recent.
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledTimes(2);
  });

  it("reports the counts it saw", async () => {
    mockQueue.getJobCounts.mockResolvedValue({
      waiting: 3,
      active: 2,
      delayed: 1,
    });

    await expect(checkQueueBacklog(T0)).resolves.toMatchObject({
      waiting: 3,
      active: 2,
      delayed: 1,
    });
  });

  it("never throws when the queue cannot be read", async () => {
    mockQueue.getJobCounts.mockRejectedValue(new Error("redis down"));
    await expect(checkQueueBacklog(T0)).resolves.toBeNull();
  });

  it("never throws when recording the alert fails", async () => {
    counts(ALARM_DEPTH);
    mockPrisma.operationalEvent.create.mockRejectedValue(new Error("db down"));

    await expect(checkQueueBacklog(T0)).resolves.toMatchObject({
      level: "alarm",
    });
  });
});
