import { describe, expect, it } from "vitest";
import { applyHarmoniqsHeaders } from "../opencode-plugin/harmoniqs_transport";

describe("Harmoniqs AI request transport", () => {
  it("adds a stable session header and retry-safe idempotency key", () => {
    const headers: Record<string, string> = {};

    applyHarmoniqsHeaders(
      { sessionID: "ses-1", model: { providerID: "harmoniqs" }, message: { id: "msg-1" } },
      { headers },
    );

    expect(headers).toEqual({
      "X-Session-Id": "ses-1",
      "Idempotency-Key": "amicode:ses-1:msg-1",
    });
  });

  it("does not alter other providers' requests", () => {
    const headers = { Existing: "value" };

    applyHarmoniqsHeaders(
      { sessionID: "ses-1", model: { providerID: "anthropic" }, message: { id: "msg-1" } },
      { headers },
    );

    expect(headers).toEqual({ Existing: "value" });
  });
});
