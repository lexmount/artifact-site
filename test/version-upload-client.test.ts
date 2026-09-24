import { expect, it, vi } from "vitest";
import { uploadVersion, VersionConflict, VersionUploadRejected } from "@/lib/version-upload-client";
import { ClientQuotaExceeded } from "@/lib/quota-client";
const files = [{ path: "index.html", file: new File(["new"], "index.html") }];
it("updates the selected artifact with an expected version and stable retry key", async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ versionId: "new", slug: "same" }));
  await uploadVersion({ slug: "same", expected: "old", key: "key123456", files, official: false }, request);
  expect(request.mock.calls[0][0]).toBe("/api/sites/same/versions?expected_version=old");
  expect(new Headers(request.mock.calls[0][1]?.headers).get("idempotency-key")).toBe("key123456");
  expect((request.mock.calls[0][1]?.body as FormData).get("official")).toBe("false");
});
it("surfaces conflicts without silently updating a newer version", async () => {
  const request = vi.fn(async () => Response.json({ currentVersionId: "newer" }, { status: 409 }));
  await expect(uploadVersion({ slug: "same", expected: "old", key: "key123456", files, official: false }, request)).rejects.toBeInstanceOf(VersionConflict);
  expect(request).toHaveBeenCalledTimes(1);
});
it("recovers a completed large upload before touching its cleaned-up session", async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ status: "completed", result: { versionId: "saved" } }));
  const big = new File([new Uint8Array(21*1024*1024)], "index.html");
  const result = await uploadVersion({ slug: "same", expected: "old", key: "key123456", files: [{path:"index.html",file:big}], official:false, session:"draft" }, request);
  expect(result.versionId).toBe("saved"); expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toBe("/api/operations/key123456");
});
it("rejects malformed success responses instead of reporting a published version", async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({}));
  await expect(uploadVersion({slug:"same",expected:"old",key:"key123456",files,official:false},request)).rejects.toThrow();
  const big = new File([new Uint8Array(21*1024*1024)], "index.html");
  request.mockClear();
  await expect(uploadVersion({slug:"same",expected:"old",key:"key123456",files:[{path:"index.html",file:big}],official:false},request)).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});
it("rejects traversal paths before making any upload request", async () => {
  const request = vi.fn<typeof fetch>();
  for(const name of ["../index.html", "folder/../index.html", "folder\\index.html", "/index.html"]) {
    await expect(uploadVersion({slug:"same",expected:"old",key:"key123456",files:[{path:name,file:files[0].file}],official:false},request)).rejects.toThrow();
  }
  expect(request).not.toHaveBeenCalled();
});

it.each([400, 413, 415, 422])("marks payload rejection %i as correctable", async status => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ error: "Invalid payload" }, { status }));
  await expect(uploadVersion({slug:"same",expected:"old",key:"key123456",files,official:false},request)).rejects.toBeInstanceOf(VersionUploadRejected);
});
it("preserves structured quota details for the interface", async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({
    error: "Storage limit reached",
    code: "quota_exceeded",
    details: { kind: "bytes", limit: 1024, used: 900, requested: 200 },
  }, { status: 403 }));
  const failed = uploadVersion({slug:"same",expected:"old",key:"key123456",files,official:false},request);
  await expect(failed).rejects.toMatchObject({
    name: "ClientQuotaExceeded",
    details: { kind: "bytes", limit: 1024, used: 900, requested: 200 },
  });
  await expect(failed).rejects.toBeInstanceOf(ClientQuotaExceeded);
});
it("does not unlock the payload when checking a previous operation fails", async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ error: "Lookup failed" }, { status: 400 }));
  const big = new File([new Uint8Array(21*1024*1024)], "index.html");
  const failed = uploadVersion({slug:"same",expected:"old",key:"key123456",files:[{path:"index.html",file:big}],official:false,session:"draft"},request);
  await expect(failed).rejects.toThrow("Lookup failed");
  await expect(failed).rejects.not.toBeInstanceOf(VersionUploadRejected);
  expect(request).toHaveBeenCalledTimes(1);
});
