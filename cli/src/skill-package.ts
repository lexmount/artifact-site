import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_RELEASES = "https://github.com/lexmount/artifact-site/releases";
export const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export interface SkillManifest { release: string; version: string; files: { path: string; sha256: string }[] }
const packagePath = /^(?:SKILL\.md|topics\.json|references\/[a-z][a-z-]*\.md|scripts\/[a-z][a-z-]*\.(?:sh|mjs))$/;

export function parseSkillManifest(text: string): SkillManifest {
  if (text.length > 32_768) throw new Error("Skill manifest is too large");
  const lines = text.trimEnd().split("\n");
  if (lines.shift() !== "format\t1") throw new Error("Unsupported skill manifest format");
  const release = lines.shift()?.split("\t");
  const version = lines.shift()?.split("\t");
  if (release?.length !== 2 || release[0] !== "release" || !/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(release[1]) || version?.length !== 2 || version[0] !== "version" || !/^[a-f0-9]{64}$/.test(version[1])) throw new Error("Invalid skill manifest version");
  const files = lines.map(line => {
    const fields = line.split("\t");
    if (fields.length !== 3 || fields[0] !== "file" || !/^[a-f0-9]{64}$/.test(fields[1]) || !packagePath.test(fields[2])) throw new Error("Invalid skill manifest file");
    return { path: fields[2], sha256: fields[1] };
  });
  if (!files.length || files.length > 128 || !files.some(f => f.path === "SKILL.md") || new Set(files.map(f => f.path)).size !== files.length) throw new Error("Invalid or duplicate skill files");
  const sorted = [...files].sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });
  if (digest(sorted.map(f => f.path + "\0" + f.sha256 + "\n").join("")) !== version[1]) throw new Error("Skill manifest checksum mismatch");
  return { release: release[1], version: version[1], files };
}

export function skillDirectory(agent?: string, directory?: string): string {
  if (directory) return path.resolve(directory);
  const home = homedir();
  const roots: Record<string, string> = {
    codex: process.env.CODEX_HOME || path.join(home, ".codex"),
    "claude-code": process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"),
    cursor: path.join(home, ".cursor"),
    opencode: path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode"),
  };
  const choose = "Choose the current agent with --agent codex|claude-code|cursor|opencode, or supply --dir for its skill directory";
  if (!agent) {
    // Prefer the running host over other clients that happen to be installed.
    const active: string[] = [];
    if (process.env.CODEX_THREAD_ID) active.push("codex");
    if (process.env.CLAUDECODE === "1") active.push("claude-code");
    if (process.env.CURSOR_AGENT) active.push("cursor");
    if (active.length > 1) throw new Error("Multiple agent sessions detected. " + choose);
    if (active.length === 1) agent = active[0];
    else {
      const installed = Object.keys(roots).filter(name => {
        try { return statSync(roots[name]).isDirectory(); }
        catch (error) {
          if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
          throw error;
        }
      });
      if (installed.length !== 1) throw new Error("Could not determine one current agent. " + choose);
      agent = installed[0];
    }
  }
  if (!Object.hasOwn(roots, agent)) throw new Error(choose);
  return path.resolve(roots[agent], "skills/artifact-site");
}

export const bundledSkillDirectory = () => fileURLToPath(new URL("../skill/", import.meta.url));

/** Never sends platform authentication or follows a URL supplied by deployment documentation. */
export async function publicText(url: string, fetcher: typeof fetch = fetch, redirects: RequestRedirect = "follow"): Promise<string> {
  const response = await fetcher(url, { credentials: "omit", redirect: redirects, headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("Could not fetch skill files (HTTP " + response.status + ")");
  return boundedText(response);
}

export const MAX_REFERENCE_BYTES = 2 * 1024 * 1024;

export async function boundedText(response: Response, max = MAX_REFERENCE_BYTES): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Error("Reference response exceeds the size limit");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

async function exists(file: string) {
  try { return await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function treeFiles(dir: string, relative = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(dir, relative), { withFileTypes: true })) {
    const rel = relative ? relative + "/" + entry.name : entry.name;
    if (entry.isSymbolicLink()) throw new Error("Refusing a symlink in the skill installation");
    if (entry.isDirectory()) {
      const nested = await treeFiles(dir, rel);
      if (!nested.length) throw new Error("Skill has additional directories; preserve local changes before updating");
      files.push(...nested);
    }
    else if (entry.isFile()) files.push(rel);
    else throw new Error("Unsupported file in skill installation");
  }
  return files.sort();
}
async function installedManifest(directory: string): Promise<SkillManifest | undefined> {
  const stat = await exists(directory);
  if (!stat) return undefined;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Skill destination must be a directory, not a symlink");
  if ((await readdir(directory)).length === 0) return undefined;
  let text: string;
  try { text = await readFile(path.join(directory, "manifest.tsv"), "utf8"); }
  catch { throw new Error("Existing skill is unmanaged or modified; preserve it and use its original installer or an empty --dir"); }
  const manifest = parseSkillManifest(text);
  const expected = ["manifest.tsv", ...manifest.files.map(f => f.path)].sort();
  if (JSON.stringify(await treeFiles(directory)) !== JSON.stringify(expected)) throw new Error("Skill has modified or additional files; preserve local changes before updating");
  for (const file of manifest.files) {
    if (digest(await readFile(path.join(directory, file.path))) !== file.sha256) throw new Error("Skill is locally modified: " + file.path + "; preserve local changes before updating");
  }
  return manifest;
}

export interface InstallSkillOptions {
  action: "install" | "update" | "check";
  directory: string;
  fetch?: typeof fetch;
  /** Explicit offline installation of the copy shipped in the npm package. */
  bundled?: boolean;
}
export async function installSkill(options: InstallSkillOptions) {
  const directory = path.resolve(options.directory);
  if (directory === path.parse(directory).root) throw new Error("A skill directory is required");
  const fetcher = options.fetch ?? fetch;
  const text = options.bundled
    ? await readFile(path.join(bundledSkillDirectory(), "manifest.tsv"), "utf8")
    : await publicText(SKILL_RELEASES + "/latest/download/skill-manifest.tsv", fetcher);
  const manifest = parseSkillManifest(text);
  const previous = await installedManifest(directory);
  if (options.action === "check") {
    let status: string;
    if (!previous) status = "missing";
    else if (previous.version === manifest.version) status = "current";
    else status = "update_available";
    return { status, directory, version: manifest.version };
  }
  if (previous?.version === manifest.version) return { status: "current", directory, version: manifest.version };
  if (options.action === "update" && !previous) throw new Error("Skill is not installed; run skill install first");
  await mkdir(path.dirname(directory), { recursive: true });
  const lock = directory + ".install-lock";
  try { await mkdir(lock); } catch { throw new Error("Another skill installation is active; inspect " + lock); }
  let staging: string | undefined;
  let backup: string | undefined;
  try {
    staging = await mkdtemp(path.join(path.dirname(directory), ".artifact-site-stage-"));
    for (const file of manifest.files) {
      const content = options.bundled ? await readFile(path.join(bundledSkillDirectory(), file.path), "utf8")
        : await publicText(SKILL_RELEASES + "/download/" + manifest.release + "/skill--" + file.path.replaceAll("/", "--"), fetcher);
      if (digest(content) !== file.sha256) throw new Error("Skill file checksum mismatch: " + file.path);
      await mkdir(path.dirname(path.join(staging, file.path)), { recursive: true });
      await writeFile(path.join(staging, file.path), content, { mode: 0o600 });
    }
    await writeFile(path.join(staging, "manifest.tsv"), text, { mode: 0o600 });
    if ((await installedManifest(directory))?.version !== previous?.version) throw new Error("Skill installation changed during update");
    if (await exists(directory)) { backup = staging + "-previous"; await rename(directory, backup); }
    try { await rename(staging, directory); staging = undefined; }
    catch (error) { if (backup) { await rename(backup, directory); backup = undefined; } throw error; }
    // Editors do not share our installer lock. Retain the old tree even after validation:
    // a save or an open file descriptor may still write to it during the directory swap.
    return { status: previous ? "updated" : "installed", directory, version: manifest.version, backupDirectory: backup };
  } finally {
    try { if (staging) await rm(staging, { recursive: true, force: true }); }
    finally {
      // A backup surviving rollback failure is intentionally left for recovery.
      await rm(lock, { recursive: true, force: true });
    }
  }
}
