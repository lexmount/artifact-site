import { afterEach, expect, it, vi } from "vitest";
const record = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", async importOriginal => ({ ...await importOriginal<object>(), recordSiteOpen: record }));
import { logSiteOpen, logShareView } from "@/lib/share";
import type { Site, Share } from "@/lib/types";
afterEach(() => { vi.restoreAllMocks(); record.mockReset(); });
it("keeps both entrances readable and logs SQLSTATE without SQL values or credentials", async () => {
  const error = Object.assign(new Error("password authentication failed for user secret-user"), {
    code: "28P01", detail: "secret token", query: "secret query", parameters: ["secret"],
  });
  record.mockRejectedValue(error);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const request = new Request("https://example.test", { headers: { "user-agent": "Mozilla/5.0" } });
  await expect(logSiteOpen(request, { id: "site" } as Site, null, null)).resolves.toBeUndefined();
  await expect(logShareView(request, { id: "share", siteId: "site" } as Share, null, null)).resolves.toBeUndefined();
  expect(log).toHaveBeenCalledTimes(2);
  for (const call of log.mock.calls) expect(call[1]).toMatchObject({ siteId: "site", errorName: "Error", code: "28P01" });
  expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
});
it("identifies connection pool timeouts that have no SQLSTATE", async () => {
  record.mockRejectedValue(new Error("timeout exceeded when trying to connect"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await logSiteOpen(new Request("https://example.test"), { id: "site" } as Site, null, null);
  expect(log.mock.calls[0][1]).toMatchObject({ reason: "connection_timeout" });
});
