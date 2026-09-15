import { expect, it } from "vitest";
import { managementReason, managementReasonHeaders } from "@/lib/management-reason";

it("transports Chinese, emoji and multiline reasons through real HTTP Headers", () => {
  const headers = new Headers(managementReasonHeaders("  支持导出\r\n工单确认 ✅  "));
  expect(managementReason(new Request("https://example.com", { headers }))).toBe("支持导出 工单确认 ✅");
});

it("preserves legacy percent text and rejects malformed encodings", () => {
  expect(managementReason(new Request("https://example.com", { headers: { "x-management-reason": "100% done %20" } }))).toBe("100% done %20");
  for (const value of ["%E0%A4", "%XX", "%00", ""]) {
    expect(managementReason(new Request("https://example.com", { headers: { "x-management-reason": value, "x-management-reason-encoding": "percent" } }))).toBeNull();
  }
});

it("enforces the length limit after decoding", () => {
  const request = (value: string) => new Request("https://example.com", { headers: managementReasonHeaders(value) });
  expect(managementReason(request("中".repeat(500)))).toBe("中".repeat(500));
  expect(managementReason(request("中".repeat(501)))).toBeNull();
  expect(managementReason(request(" \r\n "))).toBeNull();
});

it("preserves encoded management reasons when server pages rebuild a request", async () => {
  const { requestFromHeaders } = await import("@/lib/authz");
  const request = requestFromHeaders(new Headers(managementReasonHeaders("支持导出")), "/s/example");
  expect(managementReason(request)).toBe("支持导出");
});
