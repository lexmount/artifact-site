import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { recovery } from "../src/recovery.js";
import { ArtifactSiteClient } from "../src/client.js";
import { zipFiles } from "../src/archive.js";
let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "journal-tests-")); vi.stubEnv("ARTIFACT_SITE_CONFIG_DIR", dir); });
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
const client = (token = "private-token") => new ArtifactSiteClient({ baseUrl: "https://test.invalid", token, fetch: async () => Response.json({ user: { id: "same-owner" } }) });
it("reclaims a recycled PID but refuses the real active owner", async () => {
  const first = await recovery(client(), [], {}); const id = first.journal.id;
  await expect(recovery(client(), [], {})).rejects.toThrow("already running");
  await first.release();
  const file = (await readdir(path.join(dir, "uploads"))).find(name => name.endsWith(".json"))!;
  const lock = path.join(dir, "uploads", `${file}.lock`); await mkdir(lock);
  await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, birth: "a different process with this PID", nonce: "old" }));
  const recovered = await recovery(client(), [], {}); expect(recovered.journal.id).toBe(id); await recovered.release();
});
it("uses stable operation identities if an initial journal is lost", async () => {
  const first = await recovery(client(), [], {}); const id = first.journal.id; await first.release();
  await rm(path.join(dir, "uploads"), { recursive: true });
  const second = await recovery(client(), [], {}); expect(second.journal.id).toBe(id); await second.release();
});
it("rebuilds byte-identical ZIPs on a later retry", async () => {
  const file = path.join(dir, "index.html"); await writeFile(file, "<h1>Stable</h1>");
  const files = [{ relpath: "index.html", absPath: file, size: 15 }];
  vi.useFakeTimers(); vi.setSystemTime(new Date("2025-01-01"));
  const first = await zipFiles(files);
  vi.setSystemTime(new Date("2026-09-16"));
  expect(await zipFiles(files)).toEqual(first);
});

it("keeps recovery identity when the same owner rotates a personal token", async () => {
  const first = await recovery(client("old-token"), [], {}); const id = first.journal.id; await first.release();
  const second = await recovery(client("new-token"), [], {}); expect(second.journal.id).toBe(id); await second.release();
});

it("reclaims a lock if its process exits while checking birth identity", async () => {
  const first = await recovery(client(), [], {}); await first.release();
  const file = (await readdir(path.join(dir, "uploads"))).find(name => name.endsWith(".json"))!;
  const lock = path.join(dir, "uploads", `${file}.lock`); await mkdir(lock);
  const gonePid = 2147483647;
  await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: gonePid, birth: "exited", nonce: "old" }));
  const kill = vi.spyOn(process, "kill").mockReturnValueOnce(true).mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
  try { const next = await recovery(client(), [], {}); await next.release(); expect(kill).toHaveBeenCalledTimes(2); }
  finally { kill.mockRestore(); }
});

it("checks process birth after EPERM and only reclaims a mismatched identity", async () => {
  const first = await recovery(client(), [], {});
  const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
  try {
    await expect(recovery(client(), [], {})).rejects.toThrow("already running");
    const file = (await readdir(path.join(dir, "uploads"))).find(name => name.endsWith(".json"))!;
    await writeFile(path.join(dir, "uploads", `${file}.lock`, "owner.json"), JSON.stringify({ pid: process.pid, birth: "old process", nonce: "old" }));
    const next = await recovery(client(), [], {}); await next.release();
  } finally { kill.mockRestore(); await first.release(); }
});

it("applies deployment byte limits to preflight and actual ZIP expansion", async () => {
  const { preflightTree, extractZip } = await import("../src/archive.js");
  const { zipSync } = await import("fflate");
  const files = [{ relpath: "index.html", absPath: "unused", size: 600 * 1048576 }];
  const raised = { maxBytes: 1024 * 1048576, maxFileBytes: 700 * 1048576, maxFiles: 3000 };
  expect(() => preflightTree(files, raised)).not.toThrow();
  expect(() => preflightTree(files)).toThrow(/upload limits/);
  const zip = path.join(dir, "bounded.zip");
  await writeFile(zip, zipSync({ "index.html": Buffer.from("<h1>Bounded</h1>") }));
  await expect(extractZip(zip, { maxBytes: 5, maxFileBytes: 100, maxFiles: 5 })).rejects.toThrow(/expanded size/);
  const extracted = await extractZip(zip, raised); expect(extracted.files).toHaveLength(1); await extracted.cleanup();
});
