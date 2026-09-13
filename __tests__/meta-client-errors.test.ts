import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MetaApiError,
  PermissionError,
  sendPrivateReplyWithButton,
} from "@/lib/meta/client";
import { isPermanentSendFailure } from "@/lib/queue/dm-worker";

afterEach(() => vi.unstubAllGlobals());

describe("Meta send error classification", () => {
  it.each([
    [100, 2534025],
    [100, 2534014],
    [100, 2534001],
    [10, 2534022],
  ])("preserves code %i and subcode %i through the API client", async (code, subcode) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      error: {
        code,
        error_subcode: subcode,
        // Classification must not depend on Meta's English error wording.
        message: "Request rejected",
        type: "IGApiException",
        fbtrace_id: "test-trace",
      },
    }, { status: 400 })));

    const error = await sendPrivateReplyWithButton(
      "test-token", "account", "comment", "Opening message", "Send", "reveal:campaign"
    ).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(PermissionError);
    expect(error).toMatchObject({ code, subcode, fbTraceId: "test-trace" });
    expect(isPermanentSendFailure(error)).toBe(true);
  });

  it("keeps a transient service failure retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      error: { code: 2, error_subcode: 1545133, message: "Service temporarily unavailable" },
    }, { status: 500 })));

    const error = await sendPrivateReplyWithButton(
      "test-token", "account", "comment", "Opening message", "Send", "reveal:campaign"
    ).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(MetaApiError);
    expect(error).toMatchObject({ code: 2, subcode: 1545133 });
    expect(isPermanentSendFailure(error)).toBe(false);
  });
});
