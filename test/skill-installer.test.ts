import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSkillManifest } from "../cli/src/skill-package";

const exec = promisify(execFile);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
describe("shell skill installer", () => {
  it.each(["new", "empty", "unterminated", "auto", "edit-race", "pipe"])("installs and updates %s packages while preserving edits and credentials", async mode => {
    const dir = await mkdtemp(path.join(tmpdir(), "shell-skill-"));
    const destination = ["auto", "pipe"].includes(mode) ? path.join(dir, "codex config/skills/artifact-site") : path.join(dir, "skill with spaces");
    const bins = path.join(dir, "bin");
    await mkdir(bins);
    const files: Record<string, string> = { "SKILL.md": "---\nname: artifact-site\ndescription: Test\n---\n", "references/auth.md": "# Auth\n" };
    let corrupt = false;
    let unsafe = false;
    const manifest = () => {
      const rows = Object.keys(files).sort().map(file => ({ file, sha256: sha(files[file]) }));
      const version = sha(rows.map(r => r.file + "\0" + r.sha256 + "\n").join(""));
      const text = "format\t1\nrelease\tv0.6.0\nversion\t" + version + "\n" + rows.map(r => "file\t" + r.sha256 + "\t" + r.file + "\n").join("");
      if (unsafe) return text.replace("references/auth.md", "../auth.md");
      return mode === "unterminated" ? text.trimEnd() : text;
    };
    const installer = await readFile("scripts/install-skill.sh", "utf8");
    const server = createServer((req, res) => {
      const file = req.url!.split("/").at(-1)!;
      if (file === "install.sh") { res.end(installer); return; }
      res.end(file === "skill-manifest.tsv" ? manifest() : corrupt ? "corrupt" : files[file.replace(/^skill--/, "").replaceAll("--", "/")]);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    // Keep the installer's source fixed. Only this test executable maps its public requests
    // to a disposable local fixture, then uses real curl for transport and failures.
    await writeFile(path.join(bins, "curl"), "#!" + process.execPath + "\n" + `
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2), out=[];
for(let i=0;i<args.length;i++) {
 if(args[i]==='--proto'||args[i]==='--proto-redir') {i++;continue;}
 if(args[i].startsWith('https://')) {
  if(args[i] !== 'https://example.test/install.sh' && !args[i].startsWith('https://github.com/lexmount/artifact-site/releases/')) process.exit(99);
  out.push(process.env.SKILL_TEST_ORIGIN + new URL(args[i]).pathname);
 } else out.push(args[i]);
}
const r=spawnSync('/usr/bin/curl',out,{stdio:'inherit'});process.exit(r.status??1);
`, { mode: 0o700 });
    const env = { ...process.env, PATH: bins + path.delimiter + process.env.PATH, SKILL_TEST_ORIGIN: "http://127.0.0.1:" + address.port,
      CODEX_THREAD_ID: "test-session", CODEX_HOME: path.join(dir, "codex config"), CLAUDECODE: "", CURSOR_AGENT: "", SKILL_TEST_DESTINATION: destination };
    const run = (action: string) => {
      if (mode === "pipe") {
        const command = action === "install" ? 'curl -fsSL "$SKILL_TEST_INSTALLER_URL" | sh' : 'curl -fsSL "$SKILL_TEST_INSTALLER_URL" | sh -s -- "$SKILL_TEST_ACTION"';
        return exec("sh", ["-c", command], { env: { ...env, SKILL_TEST_INSTALLER_URL: "https://example.test/install.sh", SKILL_TEST_ACTION: action } });
      }
      return exec("sh", ["scripts/install-skill.sh", action, ...(mode === "auto" ? [] : ["--dir", destination])], { env });
    };
    try {
      await writeFile(path.join(dir, "credentials"), "unchanged");
      if (mode === "empty") {
        await mkdir(destination);
        await writeFile(path.join(destination, "notes.md"), "keep");
        await expect(run("install")).rejects.toThrow(/unmanaged/);
        expect(await readFile(path.join(destination, "notes.md"), "utf8")).toBe("keep");
        await rm(path.join(destination, "notes.md"));
      }
      expect((await run("check")).stdout).toContain("missing");
      await expect(run("update")).rejects.toThrow(/not installed/);
      await run("install");
      expect(await readFile(path.join(destination, "references/auth.md"), "utf8")).toBe(files["references/auth.md"]);
      parseSkillManifest(await readFile(path.join(destination, "manifest.tsv"), "utf8"));
      expect((await run("update")).stdout).toContain("current");
      files["references/auth.md"] = "# Auth\nUpdated\n";
      expect((await run("check")).stdout).toContain("update_available");
      corrupt = true;
      await expect(run("update")).rejects.toThrow(/checksum/i);
      expect(await readFile(path.join(destination, "references/auth.md"), "utf8")).toBe("# Auth\n");
      corrupt = false;
      if (mode === "edit-race") {
        // Inject an editor save after validation, immediately before the real directory move.
        await writeFile(path.join(bins, "mv"), '#!/bin/sh\nif [ "$1" = "$SKILL_TEST_DESTINATION" ]; then printf "last-second edit" > "$1/SKILL.md"; fi\nexec /bin/mv "$@"\n', { mode: 0o700 });
      }
      const updated = await run("update");
      const backup = updated.stdout.match(/^Previous skill retained at (.+)$/m)?.[1];
      expect(backup).toBeTruthy();
      expect(await readFile(path.join(backup!, "SKILL.md"), "utf8")).toBe(mode === "edit-race" ? "last-second edit" : files["SKILL.md"]);
      expect(await readFile(path.join(destination, "references/auth.md"), "utf8")).toBe(files["references/auth.md"]);
      // The final listed file must be protected even if the manifest has no final newline.
      await writeFile(path.join(destination, "references/auth.md"), "local final-file edit");
      await expect(run("update")).rejects.toThrow(/modified/i);
      expect(await readFile(path.join(destination, "references/auth.md"), "utf8")).toBe("local final-file edit");
      await writeFile(path.join(destination, "references/auth.md"), files["references/auth.md"]);
      await mkdir(path.join(destination, "local-notes"));
      await expect(run("update")).rejects.toThrow(/additional directories/i);
      await rm(path.join(destination, "local-notes"), { recursive: true });
      await writeFile(path.join(destination, "SKILL.md"), "user edit");
      await expect(run("update")).rejects.toThrow(/modified/i);
      expect(await readFile(path.join(destination, "SKILL.md"), "utf8")).toBe("user edit");
      unsafe = true;
      await expect(run("check")).rejects.toThrow(/manifest/i);
      expect(await readFile(path.join(dir, "credentials"), "utf8")).toBe("unchanged");
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
