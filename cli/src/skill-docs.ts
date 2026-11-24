import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { configDir } from "./config.js";
import { boundedText, bundledSkillDirectory, digest, MAX_REFERENCE_BYTES, skillDirectory } from "./skill-package.js";

interface Topic { id: string; url: string; sha256: string; sourceSha256: string }
interface Manifest { schemaVersion: 1; version: string; topics: Topic[] }
interface Document { id: string; text: string; source: "installed" | "cache" | "download" }
export interface ReadSkillDocsOptions { base: string; topics: string[]; installedDirectory?: string; cacheDirectory?: string; fetch?: typeof fetch }

function validateManifest(value: unknown, base: string): Manifest {
  const m = value as Manifest;
  if (!m || m.schemaVersion !== 1 || typeof m.version !== "string" || !/^[a-f0-9]{12,64}$/.test(m.version) || !Array.isArray(m.topics) || m.topics.length > 128) throw new Error("Unsupported reference manifest");
  const ids = new Set<string>();
  for (const t of m.topics) {
    if (!t || typeof t.id !== "string" || typeof t.url !== "string" || typeof t.sha256 !== "string" || typeof t.sourceSha256 !== "string") throw new Error("Invalid deployment reference");
    if (!/^[a-z][a-z-]*$/.test(t.id) || ids.has(t.id) || t.url !== base + "/agent-docs/" + t.id + ".md" || !/^[a-f0-9]{64}$/.test(t.sha256) || !/^[a-f0-9]{64}$/.test(t.sourceSha256)) throw new Error("Invalid deployment reference");
    ids.add(t.id);
  }
  return m;
}
async function maybeRead(file: string) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_REFERENCE_BYTES) return undefined;
    // The file can grow after stat; read at most one byte beyond the shared download limit.
    const buffer = Buffer.alloc(MAX_REFERENCE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) return buffer.subarray(0, size).toString("utf8");
      size += bytesRead;
    }
    return undefined;
  } finally { await handle.close(); }
}
async function atomicText(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + "." + randomUUID() + ".tmp";
  try { await writeFile(tmp, text, { mode: 0o600 }); await rename(tmp, file); }
  finally { await rm(tmp, { force: true }); }
}

function referenceDirectories(explicit?: string): string[] {
  if (explicit) return [explicit];
  const directories = [bundledSkillDirectory()];
  try { directories.unshift(skillDirectory()); }
  catch { /* Reading docs can use the bundle when no unambiguous host can be selected. */ }
  return directories;
}

/** Read reference facts only. No platform credentials and no remote code or package writes. */
export async function readSkillDocs(options: ReadSkillDocsOptions): Promise<{ version: string | null; legacy: boolean; documents: Document[] }> {
  const parsed = new URL(options.base);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Invalid deployment base URL");
  const base = parsed.href.replace(/\/+$/, "");
  if (!options.topics.length || options.topics.some(t => !/^[a-z][a-z-]*$/.test(t))) throw new Error("Select at least one valid reference topic");
  const fetcher = options.fetch ?? fetch;
  const get = (url: string) => fetcher(url, { credentials: "omit", redirect: "error", headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(30_000) });
  const response = await get(base + "/agent-docs/manifest.json");
  if (response.status === 404 || response.status === 410) {
    const legacy = await get(base + "/for-agents.md");
    if (!legacy.ok || !legacy.headers.get("content-type")?.includes("text/markdown")) throw new Error("Could not verify the legacy deployment guide");
    return { legacy: true, version: legacy.headers.get("x-artifact-site-skill-version"), documents: [{ id: "legacy", text: await boundedText(legacy), source: "download" }] };
  }
  if (!response.ok) throw new Error("Could not check deployment references (HTTP " + response.status + ")");
  const manifest = validateManifest(JSON.parse(await boundedText(response, 128 * 1024)), base);
  let cache: string | undefined;
  try { cache = path.join(options.cacheDirectory ?? path.join(configDir(), "references"), digest(base)); }
  catch { /* Optional caching is unavailable when the user's config directory cannot be resolved. */ }
  const requested = [...new Set(options.topics)];
  // Cached bytes are shared across tasks; they do not mean this caller has read the supplements.
  if (manifest.topics.some(t => t.id === "updates") && !requested.includes("updates")) requested.unshift("updates");
  const documents: Document[] = [];
  const directories = referenceDirectories(options.installedDirectory);
  for (const id of requested) {
    const topic = manifest.topics.find(t => t.id === id);
    if (!topic) throw new Error("This deployment does not advertise reference topic: " + id);
    let local: Document | undefined;
    if (id !== "updates") {
      for (const directory of directories) {
        // An unreadable local copy is a miss; every fallback still needs matching hashes.
        const installed = await maybeRead(path.join(directory, "references", id + ".md")).catch(() => undefined);
        if (installed === undefined || digest(installed) !== topic.sourceSha256) continue;
        const text = installed.split("https://artifact-site.example.com").join(base).split("{{BASE_URL}}").join(base);
        if (digest(text) === topic.sha256) { local = { id, text, source: "installed" }; break; }
      }
    }
    if (local) { documents.push(local); continue; }
    const cacheFile = cache ? path.join(cache, topic.sha256 + ".md") : undefined;
    // Persistence is optional; only verified bytes are used, even when the cache is unavailable.
    const cached = cacheFile ? await maybeRead(cacheFile).catch(() => undefined) : undefined;
    if (cached !== undefined && digest(cached) === topic.sha256) { documents.push({ id, text: cached, source: "cache" }); continue; }
    const result = await get(topic.url);
    if (!result.ok) throw new Error("Could not refresh reference " + id + " (HTTP " + result.status + ")");
    const text = await boundedText(result);
    if (digest(text) !== topic.sha256) throw new Error("Reference checksum mismatch; the deployment may have changed. Check its manifest again before continuing");
    if (cacheFile) await atomicText(cacheFile, text).catch(() => {});
    documents.push({ id, text, source: "download" });
  }
  return { version: manifest.version, legacy: false, documents };
}
