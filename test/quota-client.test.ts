import { describe, expect, it } from "vitest";
import { quotaDetailsFrom } from "@/lib/quota-client";

describe("quotaDetailsFrom", () => {
  it("accepts the public quota response shape", () => {
    expect(quotaDetailsFrom({
      code: "quota_exceeded",
      details: { kind: "sites", limit: 25, used: 25, requested: 1 },
    })).toEqual({ kind: "sites", limit: 25, used: 25, requested: 1 });
  });

  it("rejects malformed and unrelated responses", () => {
    expect(quotaDetailsFrom({ code: "forbidden", details: { kind: "sites", limit: 25, used: 25, requested: 1 } })).toBeNull();
    expect(quotaDetailsFrom({ code: "quota_exceeded", details: { kind: "bytes", limit: -1, used: 0, requested: 1 } })).toBeNull();
    expect(quotaDetailsFrom(null)).toBeNull();
  });
});
