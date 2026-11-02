import { afterEach, expect, it, vi } from "vitest";
import { fetchSiteDownload, downloadSite } from "@/lib/download";

afterEach(() => vi.unstubAllGlobals());

it("requests the selected snapshot with header credentials and preserves its filename", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([80, 75]), {
    headers: { "content-disposition": "attachment; filename*=UTF-8''saved%20version.zip" },
  }));
  vi.stubGlobal("fetch", fetch);
  const result = await fetchSiteDownload("example", "old-version", { "x-edit-token": "secret", "x-management-reason": "Support" });
  expect(fetch).toHaveBeenCalledWith("/api/sites/example/download?version=old-version", {
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
  expect(fetch.mock.calls[0][0]).toBe("/api/sites/test/download?share=grant");
});

it("surfaces permission and server failures instead of saving an error as a ZIP", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "No export permission" }), { status: 403 })));
  await expect(fetchSiteDownload("test", undefined)).rejects.toThrow("No export permission");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("gateway error", { status: 502 })));
  await expect(fetchSiteDownload("test", undefined)).rejects.toThrow("Download failed (502)");
});

it("hands a signed URL to the browser without fetching or buffering archive bytes", async () => {
  const url = "https://bucket.example/original?signature=test";
  const fetch = vi.fn().mockResolvedValue(Response.json({ url, expiresIn: 300 }));
  vi.stubGlobal("fetch", fetch);
  const frame = { src: "", hidden: false, referrerPolicy: "", setAttribute: vi.fn(), remove: vi.fn(), onload: undefined as undefined | (() => void) };
  vi.stubGlobal("window", { location: { href: "https://app.example/", origin: "https://app.example" }, setTimeout: vi.fn() });
  vi.stubGlobal("document", { createElement: vi.fn(() => frame), body: { append: vi.fn() } });
  const error = vi.fn();
  await downloadSite("test", "v1", { "x-edit-token": "secret" }, error);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe("/api/sites/test/download?version=v1&delivery=direct");
  expect(document.createElement).toHaveBeenCalledWith("iframe");
  expect(frame.src).toBe(url); expect(frame.referrerPolicy).toBe("no-referrer");
  expect(frame.hidden).toBe(true);
  expect(frame.setAttribute).toHaveBeenCalledWith("sandbox", "allow-downloads");
  expect(error).not.toHaveBeenCalled();
  frame.onload!(); expect(error).toHaveBeenCalledOnce(); expect(frame.remove).toHaveBeenCalledOnce();
});
