import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installSkill, parseSkillManifest, skillDirectory } from "../src/skill-package.js";

vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rename: vi.fn(original.rename), rm: vi.fn(original.rm) };
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function release(files = { "SKILL.md": "---\nname: artifact-site\ndescription: Test\n---\n", "references/auth.md": "# Authenticate\n" }) {
  const rows = Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, content]) => ({ file, content, hash: sha(content) }));
  const version = sha(rows.map(r => `${r.file}\0${r.hash}\n`).join(""));
  const manifest = `format\t1\nrelease\tv0.6.0\nversion\t${version}\n` + rows.map(r => `file\t${r.hash}\t${r.file}\n`).join("");
  return { manifest, files, fetch: async (url: string | URL | Request) => {
    const name = String(url).split("/").at(-1)!;
    const body = name === "skill-manifest.tsv" ? manifest : files[name.replace(/^skill--/, "").replaceAll("--", "/") as keyof typeof files];
    return new Response(body ?? "Missing", { status: body === undefined ? 404 : 200 });
  } };
}

describe("official skill package installation", () => {
  it("releases the installer lock even when staging cleanup fails", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "skill-cleanup-"));
    const directory = path.join(parent, "artifact-site");
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const one = release();
    const two = release({ ...one.files, "references/auth.md": "# Updated\n" });
    try {
      await installSkill({ directory, action: "install", fetch: one.fetch as typeof fetch });
      vi.mocked(rm).mockImplementation(async (file, options) => {
        if (String(file).startsWith(path.join(parent, ".artifact-site-stage-"))) throw Object.assign(new Error("Staging cleanup failed"), { code: "EBUSY" });
        return original.rm(file, options);
      });
      const corrupt = (async (url: string | URL | Request) => String(url).endsWith("skill--references--auth.md") ? new Response("corrupt") : two.fetch(url)) as typeof fetch;
      await expect(installSkill({ directory, action: "update", fetch: corrupt })).rejects.toThrow(/Staging cleanup failed/);
      expect(await readdir(parent)).not.toContain("artifact-site.install-lock");
      expect(await readFile(path.join(directory, "references/auth.md"), "utf8")).toBe(one.files["references/auth.md"]);
      vi.mocked(rm).mockReset();
      expect((await installSkill({ directory, action: "update", fetch: two.fetch as typeof fetch })).status).toBe("updated");
    } finally { vi.mocked(rm).mockReset(); await original.rm(parent, { recursive: true, force: true }); }
  });

  it("retains edits saved between final validation and directory replacement", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "skill-edit-race-"));
    const directory = path.join(parent, "artifact-site");
    const one = release();
    const two = release({ ...one.files, "references/auth.md": "# Updated auth\n" });
    try {
      await installSkill({ directory, action: "install", fetch: one.fetch as typeof fetch });
      const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(rename).mockImplementationOnce(async (from, to) => {
        expect(from).toBe(directory);
        await writeFile(path.join(directory, "SKILL.md"), "editor's last-second save");
        await original.rename(from, to);
      });
      const result = await installSkill({ directory, action: "update", fetch: two.fetch as typeof fetch });
      expect(result.status).toBe("updated");
      expect(result.backupDirectory).toBeTruthy();
      expect(await readFile(path.join(result.backupDirectory!, "SKILL.md"), "utf8")).toBe("editor's last-second save");
      expect(await readFile(path.join(directory, "references/auth.md"), "utf8")).toBe(two.files["references/auth.md"]);
      expect(await readdir(parent)).not.toContain("artifact-site.install-lock");
    } finally { vi.mocked(rename).mockReset(); await rm(parent, { recursive: true, force: true }); }
  });

  it.each(["constructor", "toString", "__proto__", "unknown"])("rejects unsupported agent %s with an actionable error", agent => {
    expect(() => skillDirectory(agent)).toThrow(/Choose the current agent/);
  });

  it("installs into an existing empty directory but preserves unmanaged contents", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "skill-empty-"));
    const dest = path.join(parent, "artifact-site");
    await mkdir(dest);
    const one = release();
    try {
      const options = { directory: dest, fetch: one.fetch as typeof fetch };
      expect((await installSkill({ ...options, action: "check" })).status).toBe("missing");
      await expect(installSkill({ ...options, action: "update" })).rejects.toThrow(/not installed/);
      await writeFile(path.join(dest, "notes.md"), "keep");
      await expect(installSkill({ ...options, action: "install" })).rejects.toThrow(/unmanaged/);
      expect(await readFile(path.join(dest, "notes.md"), "utf8")).toBe("keep");
      await rm(path.join(dest, "notes.md"));
      expect((await installSkill({ ...options, action: "install" })).status).toBe("installed");
      expect(await readFile(path.join(dest, "references/auth.md"), "utf8")).toBe(one.files["references/auth.md"]);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("installs the whole tree, checks, updates and leaves account configuration alone", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "skill-package-"));
    const dest = path.join(parent, "artifact-site");
    await writeFile(path.join(parent, "credentials"), "keep");
    const one = release();
    expect((await installSkill({ directory: dest, action: "check", fetch: one.fetch as typeof fetch })).status).toBe("missing");
    expect(await readdir(parent)).toEqual(["credentials"]);
    expect((await installSkill({ directory: dest, action: "install", fetch: one.fetch as typeof fetch })).status).toBe("installed");
    expect(await readFile(path.join(dest, "references/auth.md"), "utf8")).toContain("Authenticate");
    expect((await installSkill({ directory: dest, action: "update", fetch: one.fetch as typeof fetch })).status).toBe("current");
    const two = release({ ...one.files, "references/auth.md": "# New authentication\n" });
    expect((await installSkill({ directory: dest, action: "check", fetch: two.fetch as typeof fetch })).status).toBe("update_available");
    expect((await installSkill({ directory: dest, action: "update", fetch: two.fetch as typeof fetch })).status).toBe("updated");
    expect(await readFile(path.join(parent, "credentials"), "utf8")).toBe("keep");
  });

  it("preserves local edits, unknown files, symlinks and the previous tree after corrupt downloads", async () => {
    const dest = path.join(await mkdtemp(path.join(tmpdir(), "skill-protection-")), "artifact-site");
    const one = release();
    await installSkill({ directory: dest, action: "install", fetch: one.fetch as typeof fetch });
    const original = await readFile(path.join(dest, "manifest.tsv"), "utf8");
    const two = release({ ...one.files, "references/auth.md": "new" });
    const corrupt = async (url: string | URL | Request) => String(url).endsWith("skill--references--auth.md") ? new Response("corrupt") : two.fetch(url);
    await expect(installSkill({ directory: dest, action: "update", fetch: corrupt as typeof fetch })).rejects.toThrow(/checksum/i);
    expect(await readFile(path.join(dest, "manifest.tsv"), "utf8")).toBe(original);
    await mkdir(path.join(dest, "local-notes"));
    await expect(installSkill({ directory: dest, action: "update", fetch: two.fetch as typeof fetch })).rejects.toThrow(/additional directories/i);
    await rm(path.join(dest, "local-notes"), { recursive: true });
    await writeFile(path.join(dest, "SKILL.md"), "user changes");
    await expect(installSkill({ directory: dest, action: "update", fetch: two.fetch as typeof fetch })).rejects.toThrow(/modified/i);
    expect(await readFile(path.join(dest, "SKILL.md"), "utf8")).toBe("user changes");
    const linked = dest + "-link";
    await symlink(dest, linked);
    await expect(installSkill({ directory: linked, action: "install", fetch: two.fetch as typeof fetch })).rejects.toThrow(/symlink/i);
  });

  it("rejects untrusted paths, duplicate files and unsupported manifest formats", () => {
    const m = release().manifest;
    for (const bad of [m.replace("format\t1", "format\t2"), m.replace("references/auth.md", "../auth.md"), m + m.split("\n").find(l => l.startsWith("file\t")) + "\n"]) {
      expect(() => parseSkillManifest(bad)).toThrow();
    }
  });
});
