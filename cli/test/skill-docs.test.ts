import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { readSkillDocs } from "../src/skill-docs.js";
import { bundledSkillDirectory, installSkill } from "../src/skill-package.js";
import { configDir } from "../src/config.js";

vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, writeFile: vi.fn(original.writeFile), readFile: vi.fn(original.readFile), open: vi.fn(original.open) };
});
vi.mock("../src/config.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/config.js")>();
  return { ...original, configDir: vi.fn(original.configDir) };
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const base = "https://example.test/mount";
function fixture() {
  const texts: Record<string, string> = { publish: "# Publish\nOne", records: "# Records\nTwo", updates: "# Updates\nChanges" };
  const state = { version: "0123456789ab", corrupt: false, requests: [] as string[] };
  const fetcher = async (url: string | URL | Request, options?: RequestInit) => {
    expect(options?.credentials).toBe("omit");
    expect(options?.redirect).toBe("error");
    expect(options?.headers).not.toHaveProperty("authorization");
    const value = String(url); state.requests.push(value);
    if (value.endsWith("manifest.json")) return Response.json({ schemaVersion: 1, version: state.version, topics: Object.entries(texts).map(([id, text]) => ({ id, url: base + "/agent-docs/" + id + ".md", sha256: sha(text), sourceSha256: sha(text) })) });
    const id = value.split("/").at(-1)!.replace(/\.md$/, "");
    return new Response(state.corrupt ? "corrupt" : texts[id]);
  };
  return { state, texts, fetcher: fetcher as typeof fetch };
}
describe("deployment reference freshness", () => {
  const limit = 2 * 1024 * 1024;
  it.each(["installed", "cache"].flatMap(source => [0, 1].map(extra => ({ source, extra }))))("bounds $source references at 2 MiB ($extra extra bytes), even with matching checksums", async ({ source, extra }) => {
    const temp = await mkdtemp(path.join(tmpdir(), "skill-bounded-docs-"));
    try {
      const text = "文".repeat(Math.floor(limit / 3)) + "a".repeat(limit % 3 + extra);
      const hash = sha(text);
      const file = source === "installed" ? path.join(temp, "installed/references/publish.md") : path.join(temp, "cache", sha(base), hash + ".md");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
      const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith("manifest.json")
        ? Response.json({ schemaVersion: 1, version: "0123456789ab", topics: [{ id: "publish", url: base + "/agent-docs/publish.md", sha256: hash, sourceSha256: hash }] })
        : new Response("Unavailable", { status: 503 }));
      const result = readSkillDocs({ base, topics: ["publish"], installedDirectory: path.join(temp, "installed"), cacheDirectory: path.join(temp, "cache"), fetch: fetcher });
      if (extra) await expect(result.then(() => "oversized reference accepted")).rejects.toThrow(/HTTP 503/);
      else expect((await result).documents).toEqual([{ id: "publish", text, source }]);
      expect(fetcher).toHaveBeenCalledTimes(extra ? 2 : 1);
      expect(await readFile(file, "utf8")).toBe(text);
    } finally { await rm(temp, { recursive: true, force: true }); }
  });

  it.each(["installed", "cache"])("uses a verified download after an oversized %s miss", async source => {
    const temp = await mkdtemp(path.join(tmpdir(), "skill-oversized-docs-"));
    try {
      const f = fixture();
      const text = "x".repeat(limit + 1);
      const file = source === "installed" ? path.join(temp, "installed/references/publish.md") : path.join(temp, "cache", sha(base), sha(f.texts.publish) + ".md");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
      const result = await readSkillDocs({ base, topics: ["publish"], installedDirectory: path.join(temp, "installed"), cacheDirectory: path.join(temp, "cache"), fetch: f.fetcher });
      expect(result.documents.find(d => d.id === "publish")).toEqual({ id: "publish", text: f.texts.publish, source: "download" });
      expect(await readFile(file, "utf8")).toBe(source === "installed" ? text : f.texts.publish);
    } finally { await rm(temp, { recursive: true, force: true }); }
  });

  it("stops reading at the limit when an installed reference grows after its size check", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "skill-growing-docs-"));
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const file = path.join(temp, "installed/references/publish.md");
    let readBytes = 0;
    let closed = false;
    try {
      const f = fixture();
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, f.texts.publish);
      vi.mocked(open).mockImplementation(async (name, flags, mode) => {
        const handle = await original.open(name, flags, mode);
        if (String(name) === file) {
          const stat = handle.stat.bind(handle);
          vi.spyOn(handle, "stat").mockImplementation(async () => {
            const snapshot = await stat();
            await original.writeFile(file, "x".repeat(limit * 2));
            return snapshot;
          });
          const read = handle.read.bind(handle);
          vi.spyOn(handle, "read").mockImplementation(async (...args) => {
            const result = await read(...args);
            readBytes += result.bytesRead;
            return result;
          });
          const close = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementation(async () => { await close(); closed = true; });
        }
        return handle;
      });
      const result = await readSkillDocs({ base, topics: ["publish"], installedDirectory: path.join(temp, "installed"), cacheDirectory: path.join(temp, "cache"), fetch: f.fetcher });
      expect(result.documents.find(d => d.id === "publish")?.source).toBe("download");
      expect(readBytes).toBe(limit + 1);
      expect(closed).toBe(true);
    } finally { vi.mocked(open).mockReset(); vi.restoreAllMocks(); await rm(temp, { recursive: true, force: true }); }
  });

  it.each(["bundle", "download"])("uses verified %s references without cache when directory resolution throws", async source => {
    const temp = await mkdtemp(path.join(tmpdir(), "skill-no-home-"));
    try {
      const authored = source === "bundle" ? await readFile(path.join(bundledSkillDirectory(), "references/publish.md"), "utf8") : "# Publish";
      const text = authored.split("https://artifact-site.example.com").join(base).split("{{BASE_URL}}").join(base);
      const updates = "# Updates";
      let corrupt = false;
      const fetcher = vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("manifest.json")) return Response.json({ schemaVersion: 1, version: "0123456789ab", topics: [
          { id: "publish", url: base + "/agent-docs/publish.md", sha256: sha(text), sourceSha256: sha(authored) },
          { id: "updates", url: base + "/agent-docs/updates.md", sha256: sha(updates), sourceSha256: sha(updates) },
        ] });
        if (corrupt) return new Response("corrupt");
        return new Response(String(url).endsWith("updates.md") ? updates : text);
      });
      vi.mocked(configDir).mockImplementation(() => { throw new Error("uv_os_homedir failed"); });
      vi.mocked(writeFile).mockClear();
      const options = { base, topics: ["publish"], installedDirectory: source === "bundle" ? bundledSkillDirectory() : temp, fetch: fetcher };
      for (let task = 0; task < 2; task++) {
        const result = await readSkillDocs(options);
        expect(result.documents).toEqual([{ id: "updates", text: updates, source: "download" }, { id: "publish", text, source: source === "bundle" ? "installed" : "download" }]);
      }
      expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
      expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("updates.md"))).toHaveLength(2);
      corrupt = true;
      await expect(readSkillDocs(options)).rejects.toThrow(/checksum/i);
    } finally { vi.mocked(configDir).mockReset(); await rm(temp, { recursive: true, force: true }); }
  });

  it("keeps an explicit cache usable when default directory resolution would throw", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "skill-explicit-cache-"));
    try {
      vi.mocked(configDir).mockImplementation(() => { throw new Error("uv_os_homedir failed"); });
      const f = fixture();
      const options = { base, topics: ["publish"], installedDirectory: temp, cacheDirectory: path.join(temp, "cache"), fetch: f.fetcher };
      await readSkillDocs(options);
      expect((await readSkillDocs(options)).documents.map(d => d.source)).toEqual(["cache", "cache"]);
      expect(configDir).not.toHaveBeenCalled();
    } finally { vi.mocked(configDir).mockReset(); await rm(temp, { recursive: true, force: true }); }
  });

  const validFields = { version: "123456789012", id: "publish", url: base + "/agent-docs/publish.md", sha256: sha("# Publish"), sourceSha256: sha("# Publish") };
  it.each(Object.entries(validFields).flatMap(([field, valid]) => [
    { type: "number", value: 123456789012 },
    { type: "array", value: [valid] },
    { type: "null", value: null },
    { type: "boolean", value: true },
    { type: "object", value: {} },
    { type: "missing", value: undefined },
  ].map(entry => ({ field, ...entry }))))("rejects a manifest with $type $field before reading references", async ({ field, value }) => {
    const temp = await mkdtemp(path.join(tmpdir(), "skill-invalid-manifest-"));
    try {
      const { version, ...topic } = validFields;
      const manifest = field === "version"
        ? { schemaVersion: 1, version: value, topics: [topic] }
        : { schemaVersion: 1, version, topics: [{ ...topic, [field]: value }] };
      const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith("manifest.json") ? Response.json(manifest) : new Response("# Publish"));
      await expect(readSkillDocs({ base, topics: ["publish"], installedDirectory: temp, cacheDirectory: temp, fetch: fetcher })).rejects.toThrow(field === "version" ? "Unsupported reference manifest" : "Invalid deployment reference");
      expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([base + "/agent-docs/manifest.json"]);
    } finally { await rm(temp, { recursive: true, force: true }); }
  });

  it("preserves a valid numeric-looking string version in JSON output", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "skill-string-version-"));
    try {
      const f = fixture();
      f.state.version = validFields.version;
      const result = await readSkillDocs({ base, topics: ["publish"], installedDirectory: temp, cacheDirectory: temp, fetch: f.fetcher });
      expect(JSON.parse(JSON.stringify(result)).version).toBe(validFields.version);
    } finally { await rm(temp, { recursive: true, force: true }); }
  });

  it.each(["EACCES", "EISDIR", "ENOTDIR"].flatMap(code => ["bundle", "download"].map(source => ({ code, source }))))("skips an unreadable installed reference ($code) and uses a verified $source", async ({ code, source }) => {
    const temp = await mkdtemp(path.join(tmpdir(), "skill-unreadable-docs-"));
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const installedFile = path.join(temp, "client/skills/artifact-site/references/publish.md");
    vi.stubEnv("CODEX_HOME", path.join(temp, "client"));
    vi.stubEnv("CODEX_THREAD_ID", "docs-test");
    vi.stubEnv("CLAUDECODE", "");
    vi.stubEnv("CURSOR_AGENT", "");
    try {
      await mkdir(path.dirname(installedFile), { recursive: true });
      await writeFile(installedFile, "keep this local content");
      const authored = source === "bundle" ? await original.readFile(path.join(bundledSkillDirectory(), "references/publish.md"), "utf8") : "# Verified replacement";
      const text = authored.split("https://artifact-site.example.com").join(base).split("{{BASE_URL}}").join(base);
      vi.mocked(open).mockImplementation(async (file, flags, mode) => {
        if (String(file) === installedFile) throw Object.assign(new Error("Local reference unreadable"), { code });
        return original.open(file, flags, mode);
      });
      let corrupt = false;
      const requests: string[] = [];
      const fetcher = (async (url: string | URL | Request) => {
        requests.push(String(url));
        if (String(url).endsWith("manifest.json")) return Response.json({ schemaVersion: 1, version: "0123456789ab", topics: [{ id: "publish", url: base + "/agent-docs/publish.md", sourceSha256: sha(authored), sha256: sha(text) }] });
        if (source === "bundle") throw new Error("Topic download unavailable");
        return new Response(corrupt ? "corrupt" : text);
      }) as typeof fetch;
      const options = { base, topics: ["publish"], cacheDirectory: path.join(temp, "cache"), fetch: fetcher };
      expect((await readSkillDocs(options)).documents).toEqual([{ id: "publish", text, source: source === "bundle" ? "installed" : "download" }]);
      expect(requests).toHaveLength(source === "bundle" ? 1 : 2);
      expect(await original.readFile(installedFile, "utf8")).toBe("keep this local content");
      if (source === "download") {
        corrupt = true;
        await expect(readSkillDocs({ ...options, cacheDirectory: path.join(temp, "fresh-cache") })).rejects.toThrow(/checksum/i);
      }
    } finally { vi.mocked(open).mockReset(); vi.unstubAllEnvs(); await rm(temp, { recursive: true, force: true }); }
  });

  it.each(["EACCES", "EROFS", "ENOSPC"])("returns verified supplements and installed topics when cache persistence fails with %s", async code => {
    const temp = await mkdtemp(path.join(tmpdir(), "skill-cache-failure-"));
    const cache = path.join(temp, "cache");
    const installed = path.join(temp, "installed");
    const f = fixture();
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    try {
      await mkdir(path.join(installed, "references"), { recursive: true });
      await writeFile(path.join(installed, "references/publish.md"), f.texts.publish);
      vi.mocked(writeFile).mockImplementation(async (file, data, options) => {
        if (String(file).startsWith(cache + path.sep)) throw Object.assign(new Error("Cache write failed"), { code });
        return original.writeFile(file, data, options);
      });
      const options = { base, topics: ["publish"], installedDirectory: installed, cacheDirectory: cache, fetch: f.fetcher };
      const result = await readSkillDocs(options);
      expect(result.documents).toEqual([{ id: "updates", text: f.texts.updates, source: "download" }, { id: "publish", text: f.texts.publish, source: "installed" }]);
      f.state.corrupt = true;
      await expect(readSkillDocs(options)).rejects.toThrow(/checksum/i);
    } finally { vi.mocked(writeFile).mockReset(); await rm(temp, { recursive: true, force: true }); }
  });

  it("uses verified downloads when the cache path cannot be read or created", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "skill-cache-path-"));
    try {
      const cache = path.join(temp, "not-a-directory");
      await writeFile(cache, "occupied");
      const f = fixture();
      const result = await readSkillDocs({ base, topics: ["publish"], cacheDirectory: cache, fetch: f.fetcher });
      expect(result.documents.map(d => d.source)).toEqual(["download", "download"]);
      expect(await readFile(cache, "utf8")).toBe("occupied");
    } finally { await rm(temp, { recursive: true, force: true }); }
  });

  it("reuses the detected installation after an independent skill update when topic downloads fail", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "skill-detected-docs-"));
    const directory = path.join(temp, "client/skills/artifact-site");
    vi.stubEnv("CODEX_HOME", path.join(temp, "client"));
    vi.stubEnv("CODEX_THREAD_ID", "docs-test");
    vi.stubEnv("CLAUDECODE", "");
    vi.stubEnv("CURSOR_AGENT", "");
    try {
      const f = fixture();
      for (const action of ["install", "update"] as const) {
        f.texts.publish = "# Publish\nIndependent release: " + action;
        const files: Record<string, string> = { "SKILL.md": "---\nname: artifact-site\ndescription: Test\n---\n", "references/publish.md": f.texts.publish };
        const rows = Object.keys(files).sort().map(file => [file, files[file]] as const);
        const version = sha(rows.map(([file, text]) => file + "\0" + sha(text) + "\n").join(""));
        const manifest = `format\t1\nrelease\tv0.6.0\nversion\t${version}\n` + rows.map(([file, text]) => `file\t${sha(text)}\t${file}\n`).join("");
        const release = (async (url: string | URL | Request) => {
          const name = String(url).split("/").at(-1)!;
          return new Response(name === "skill-manifest.tsv" ? manifest : files[name.replace(/^skill--/, "").replaceAll("--", "/")]);
        }) as typeof fetch;
        await installSkill({ action, directory, fetch: release });
      }
      const fetcher = (async (url: string | URL | Request, options?: RequestInit) => {
        if (String(url).endsWith("publish.md")) throw new Error("Topic download is unavailable");
        return f.fetcher(url, options);
      }) as typeof fetch;
      const options = { base, topics: ["publish"], cacheDirectory: path.join(temp, "cache"), fetch: fetcher };
      const result = await readSkillDocs(options);
      expect(result.documents.find(d => d.id === "publish")).toEqual({ id: "publish", text: f.texts.publish, source: "installed" });
      expect(result.documents.find(d => d.id === "updates")?.source).toBe("download");

      const explicit = path.join(temp, "custom");
      f.texts.publish = "# Explicit directory takes priority";
      await mkdir(path.join(explicit, "references"), { recursive: true });
      await writeFile(path.join(explicit, "references/publish.md"), f.texts.publish);
      expect((await readSkillDocs({ ...options, installedDirectory: explicit })).documents.find(d => d.id === "publish")?.text).toBe(f.texts.publish);
    } finally { vi.unstubAllEnvs(); await rm(temp, { recursive: true, force: true }); }
  });

  it.each(["ambiguous", "missing"])("keeps the bundled fallback when the agent installation is %s", async mode => {
    const temp = await mkdtemp(path.join(tmpdir(), "skill-bundled-docs-"));
    vi.stubEnv("CODEX_HOME", path.join(temp, "client"));
    vi.stubEnv("CODEX_THREAD_ID", "docs-test");
    vi.stubEnv("CLAUDECODE", mode === "ambiguous" ? "1" : "");
    vi.stubEnv("CURSOR_AGENT", "");
    try {
      const source = await readFile(path.join(bundledSkillDirectory(), "references/publish.md"), "utf8");
      const text = source.split("https://artifact-site.example.com").join(base).split("{{BASE_URL}}").join(base);
      const fetcher = (async (url: string | URL | Request) => {
        if (!String(url).endsWith("manifest.json")) throw new Error("Topic download is unavailable");
        return Response.json({ schemaVersion: 1, version: "0123456789ab", topics: [{ id: "publish", url: base + "/agent-docs/publish.md", sha256: sha(text), sourceSha256: sha(source) }] });
      }) as typeof fetch;
      const result = await readSkillDocs({ base, topics: ["publish"], cacheDirectory: temp, fetch: fetcher });
      expect(result.documents).toEqual([{ id: "publish", text, source: "installed" }]);
    } finally { vi.unstubAllEnvs(); await rm(temp, { recursive: true, force: true }); }
  });

  it("returns supplements to independent tasks sharing one cache without downloading them again", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "skill-shared-docs-"));
    const firstTask = fixture();
    const options = { base, topics: ["publish"], cacheDirectory: temp };
    const first = await readSkillDocs({ ...options, fetch: firstTask.fetcher });
    expect(first.documents.find(d => d.id === "updates")).toEqual({ id: "updates", text: firstTask.texts.updates, source: "download" });
    const secondTask = fixture();
    const second = await readSkillDocs({ ...options, fetch: secondTask.fetcher });
    expect(second.documents.find(d => d.id === "updates")).toEqual({ id: "updates", text: secondTask.texts.updates, source: "cache" });
    expect(secondTask.state.requests).toEqual([base + "/agent-docs/manifest.json"]);
  });

  it("reads matching local topics, reuses verified cache and fetches only changed needed topics", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "skill-docs-"));
    const f = fixture();
    const installed = path.join(temp, "installed");
    await mkdir(path.join(installed, "references"), { recursive: true });
    await writeFile(path.join(installed, "references/publish.md"), f.texts.publish);
    const opts = { base, topics: ["publish"], cacheDirectory: path.join(temp, "cache"), installedDirectory: installed, fetch: f.fetcher };
    const first = await readSkillDocs(opts);
    expect(first.documents.find(d => d.id === "publish")?.source).toBe("installed");
    expect(f.state.requests.some(u => u.endsWith("records.md"))).toBe(false);
    expect(f.state.requests.some(u => u.endsWith("publish.md"))).toBe(false);
    f.texts.publish = "# Publish\nNew API"; f.state.version = "1123456789ab";
    expect((await readSkillDocs(opts)).documents.find(d => d.id === "publish")?.text).toContain("New API");
    f.state.requests.length = 0;
    const cached = await readSkillDocs(opts);
    expect(cached.documents.find(d => d.id === "publish")?.source).toBe("cache");
    expect(f.state.requests).toEqual([base + "/agent-docs/manifest.json"]);
    f.texts.publish = "# Publish\nNext"; f.state.version = "2123456789ab"; f.state.corrupt = true;
    await expect(readSkillDocs(opts)).rejects.toThrow(/checksum/i);
  });

  it("falls back only on an absent manifest and refuses cross-origin references", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "skill-legacy-"));
    const fallback = (async (url: string | URL | Request) => String(url).endsWith("manifest.json") ? new Response("Missing", { status: 404 }) : new Response("# Legacy guide", { headers: { "content-type": "text/markdown" } })) as typeof fetch;
    expect((await readSkillDocs({ base, topics: ["publish"], cacheDirectory: temp, fetch: fallback })).legacy).toBe(true);
    const denied = (async () => new Response("Denied", { status: 403 })) as typeof fetch;
    await expect(readSkillDocs({ base, topics: ["publish"], cacheDirectory: temp, fetch: denied })).rejects.toThrow(/403/);
    const escaped = (async () => Response.json({ schemaVersion: 1, version: "0123456789ab", topics: [{ id: "publish", url: "https://attacker.test/doc.md", sha256: sha("x"), sourceSha256: sha("x") }] })) as typeof fetch;
    await expect(readSkillDocs({ base, topics: ["publish"], cacheDirectory: temp, fetch: escaped })).rejects.toThrow(/reference/i);
  });
});
