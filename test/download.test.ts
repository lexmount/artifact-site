import { afterEach, expect, it, vi } from "vitest";
import { fetchSiteDownload } from "@/lib/download";

afterEach(() => vi.unstubAllGlobals());

it("requests the selected snapshot with header credentials and preserves its filename", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([80, 75]), {
    headers: { "content-disposition": "attachment; filename*=UTF-8''saved%20version.zip" },
  }));
  vi.stubGlobal("fetch", fetch);
  const result = await fetchSiteDownload("example", "old-version", { "x-edit-token": "secret", "x-management-reason": "Support" });
  expect(fetch).toHaveBeenCalledWith("/api/sites/example/export?version=old-version", {
    headers: { "x-edit-token": "secret", "x-management-reason": "Support" }, cache: "no-store",
  });
  expect(result.filename).toBe("saved version.zip");
  expect(result.blob.size).toBe(2);
});

it("carries an edit-share credential and leaves current-version resolution to the server", async () => {
  vi.stubGlobal("window", { location: { href: "https://example.com/s/test/edit?share=grant", origin: "https://example.com" } });
  const fetch = vi.fn().mockResolvedValue(new Response("zip"));
  vi.stubGlobal("fetch", fetch);
  expect((await fetchSiteDownload("test", undefined)).filename).toBe("test.zip");
  expect(fetch.mock.calls[0][0]).toBe("/api/sites/test/export?share=grant");
});

it("surfaces permission and server failures instead of saving an error as a ZIP", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "No export permission" }), { status: 403 })));
  await expect(fetchSiteDownload("test", undefined)).rejects.toThrow("No export permission");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("gateway error", { status: 502 })));
  await expect(fetchSiteDownload("test", undefined)).rejects.toThrow("Download failed (502)");
});
