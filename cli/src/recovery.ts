import { execFile } from "node:child_process";
import { promisify } from "node:util";
// Durable journals contain hashes and operation IDs, never bearer tokens or share secrets.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { configDir } from "./config.js";
import type { WalkedFile } from "./archive.js";
import { ApiError, type ArtifactSiteClient, type VersionResult } from "./client.js";

const exec = promisify(execFile);
/** Birth identity distinguishes the original worker from an unrelated recycled PID. */
async function processBirth(pid: number): Promise<string> {
  if (process.platform === "linux") {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const started = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
    return `${(await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()}:${started}`;
  }
  const { stdout } = process.platform === "win32"
    ? await exec("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`])
    : await exec("ps", ["-p", String(pid), "-o", "lstart="], { env: { ...process.env, LC_ALL: "C" } });
  if (!stdout.trim()) throw new Error("Could not determine publication process birth time");
  return stdout.trim();
}

export interface Journal { id: string; createdAt: number; fingerprint: string; versionId?: string; generation: number; inlineAttempted?: boolean; commitAttempted?: boolean; done: string[]; result?: VersionResult; error?: { message: string; status?: number; code?: string } }
export async function fileHash(file: string): Promise<string> {
  const h = createHash("sha256"); for await (const bytes of createReadStream(file)) h.update(bytes); return h.digest("hex");
}
export async function recovery(client: ArtifactSiteClient, files: WalkedFile[], parameters: unknown) {
  const manifest: [string, number, string][] = [];
  for (const f of files) manifest.push([f.relpath, f.size, await fileHash(f.absPath)]);
  const fingerprint = createHash("sha256").update(JSON.stringify([manifest, parameters])).digest("hex");
  const explicit = (parameters as { operationKey?: string }).operationKey;
  const name = createHash("sha256").update(JSON.stringify([await client.recoveryIdentity(), explicit || fingerprint])).digest("hex");
  const dir = path.join(configDir(), "uploads"); await mkdir(dir, { recursive: true, mode: 0o700 });
  const filename = path.join(dir, `${name}.json`);
  const lock = `${filename}.lock`;
  const own = { pid: process.pid, birth: await processBirth(process.pid), nonce: randomUUID() };
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner: { pid: number; birth: string };
    try { owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")); }
    catch { throw new Error(`Publication lock is incomplete or from an older client. Inspect ${lock} before removing it.`); }
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.birth !== "string") throw new Error(`Invalid recovery lock: ${lock}`);
    let alive = true;
    try { process.kill(owner.pid, 0); }
    catch (e) { const code = (e as NodeJS.ErrnoException).code; if (code === "ESRCH") alive = false; else if (code !== "EPERM") throw e; }
    let birth: string | undefined;
    if (alive) {
      try { birth = await processBirth(owner.pid); }
      catch (error) {
        // The owner may exit between kill(0) and reading its birth identity.
        // Only reclaim on confirmed exit; permission/system errors must not steal a live lock.
        try { process.kill(owner.pid, 0); }
        catch (probe) { if ((probe as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
        if (alive) throw error;
      }
    }
    if (alive && birth === owner.birth) throw new Error("This publication is already running in another process");
    await rm(lock, { recursive: true }); await mkdir(lock, { mode: 0o700 });
  }
  await writeFile(path.join(lock, "owner.json"), JSON.stringify(own), { mode: 0o600 });
  const ownsLock = async () => {
    try { return JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")).nonce === own.nonce; } catch { return false; }
  };
  const release = async () => { if (await ownsLock()) await rm(lock, { recursive: true, force: true }); };
  try {
  let journal: Journal;
  try { journal = JSON.parse(await readFile(filename, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; journal = { id: name, createdAt: Date.now(), fingerprint, generation: 0, done: [] }; }
  if (journal.fingerprint !== fingerprint) throw new Error("This operation key was already used with different files or parameters");
  if (Date.now() - journal.createdAt >= 7 * 86400000) throw new Error(`Recovery expired. Inspect the previous publication before choosing a new --operation-key. Journal: ${filename}`);
  const save = async () => {
    if (!await ownsLock()) throw new Error("Publication lock changed; stop and retry with the same operation key");
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(journal, (key, value) => key === "editToken" || key === "claimToken" ? undefined : value), { mode: 0o600 }); if (!await ownsLock()) { await rm(temporary, { force: true }); throw new Error("Publication lock changed; retry with the same operation key"); }
    await rename(temporary, filename);
  };
  await save();
  return { journal, save, release, hashes: new Map(manifest.map(([name, , hash]) => [name, hash])), async failed(error: unknown) {
    journal.error = { message: error instanceof Error ? error.message : String(error), ...(error instanceof ApiError ? { status: error.status, code: error.code } : {}) }; await save();
  } };
  } catch (error) { await release(); throw error; }
}
