import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const { load } = createRequire(import.meta.url)("js-yaml") as { load: (text: string) => unknown };
const workflow = load(readFileSync(".github/workflows/release.yml", "utf8")) as {
  concurrency?: { group: string; "cancel-in-progress": boolean };
  jobs: { skills: { "timeout-minutes"?: number; steps: { name?: string; run?: string }[] } };
};
const publish = workflow.jobs.skills.steps.find(s => s.name === "Publish immutable skill files and manifest")!.run!;
function releaseAssets(tag: string) {
  const files = { "SKILL.md": "# Skill\n", "references/auth.md": "# Auth\n" };
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const rows = Object.entries(files);
  const version = hash(rows.map(([name, text]) => name + "\0" + hash(text) + "\n").join(""));
  return { "skill--SKILL.md": files["SKILL.md"], "skill--references--auth.md": files["references/auth.md"], "install.sh": "# Installer\n",
    "skill-manifest.tsv": `format\t1\nrelease\t${tag}\nversion\t${version}\n` + rows.map(([name, text]) => `file\t${hash(text)}\t${name}\n`).join("") };
}
interface ReleaseState { exists: boolean; draft: boolean; prerelease: boolean; assets: Record<string, string>; starters?: Record<string, number>; calls: string[][]; incompleteVisible: boolean; publicAssetMutation: boolean; overlapStarted?: boolean; overlappingPublisherStatus?: number }

function run(options: { existing?: "draft" | "published"; missing?: boolean; modified?: boolean; fail?: "files" | "manifest"; starter?: "empty" | "unavailable"; prerelease?: boolean; draftPrerelease?: boolean; overlap?: "create" | "upload"; invalid?: "missing" | "corrupt" | "wrong-tag" | "checksum" | "unsafe-path" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "publish-skill-"));
  const tag = options.prerelease ? "v0.6.0-rc.1" : "v0.6.0";
  const assets = releaseAssets(tag);
  try {
    for (const dir of ["dist-skill", "bin", "scripts"]) mkdirSync(path.join(root, dir));
    for (const [file, text] of Object.entries(assets)) writeFileSync(path.join(root, "dist-skill", file), text);
    if (options.invalid === "missing") rmSync(path.join(root, "dist-skill/skill--references--auth.md"));
    if (options.invalid === "corrupt") writeFileSync(path.join(root, "dist-skill/skill--references--auth.md"), "corrupt");
    let manifest = assets["skill-manifest.tsv"];
    if (options.invalid === "wrong-tag") manifest = manifest.replace(tag, "v9.9.9");
    if (options.invalid === "checksum") manifest = manifest.replace(/version\t[a-f0-9]+/, "version\t" + "0".repeat(64));
    if (options.invalid === "unsafe-path") manifest = manifest.replace("references/auth.md", "../auth.md");
    writeFileSync(path.join(root, "dist-skill/skill-manifest.tsv"), manifest);
    const script = "scripts/publish-skill.sh";
    if (existsSync(script)) copyFileSync(script, path.join(root, script));
    const initial: ReleaseState = { exists: Boolean(options.existing), draft: options.existing === "draft", prerelease: options.draftPrerelease ?? Boolean(options.prerelease), assets: options.existing ? { ...assets } : {}, calls: [], incompleteVisible: false, publicAssetMutation: false };
    if (options.missing) delete initial.assets["skill-manifest.tsv"];
    if (options.modified) initial.assets["skill--SKILL.md"] = "published content";
    writeFileSync(path.join(root, "state.json"), JSON.stringify(initial));
    // Simulate GitHub's release visibility and asset storage, without contacting GitHub.
    writeFileSync(path.join(root, "bin/gh"), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
let state = JSON.parse(fs.readFileSync('state.json', 'utf8'));
const args = process.argv.slice(2), command = args[1];
state.calls.push(args);
if (process.env.SKILL_OVERLAP === command && !state.overlapStarted) {
  // Pause this invocation after discovery; let another real publisher finish first.
  state.overlapStarted = true;
  fs.writeFileSync('state.json', JSON.stringify(state));
  const other = require('node:child_process').spawnSync('bash', ['scripts/publish-skill.sh'], {
    env: { ...process.env, SKILL_OVERLAP: '', SKILL_FAIL_UPLOAD: '' }, timeout: 10000,
  });
  state = JSON.parse(fs.readFileSync('state.json', 'utf8'));
  state.overlappingPublisherStatus = other.status;
}
let code = 0;
const option = name => args[args.indexOf(name) + 1];
if (args[0] === 'api') {
  if (args.includes('--method')) code = 90; // The publisher must never delete assets.
  else process.stdout.write(Object.values(state.starters ?? {}).join('\\n'));
} else if (command === 'view') {
  if (!state.exists) code = 1;
  else if (args.includes('--json')) process.stdout.write(String(state.draft));
} else if (command === 'create') {
  if (state.exists) code = 1;
  else { state.exists = true; state.draft = args.includes('--draft'); state.prerelease = args.includes('--prerelease'); }
} else if (command === 'upload') {
  const files = args.slice(3).filter(a => !a.startsWith('--'));
  const manifest = files.some(f => path.basename(f) === 'skill-manifest.tsv');
  for (const file of files) {
    const name = path.basename(file);
    if (name in state.assets) {
      if (!args.includes('--clobber')) { code = 1; break; }
      if (!state.draft) state.publicAssetMutation = true;
      delete state.assets[name];
    }
    if (process.env.SKILL_FAIL_UPLOAD === (manifest ? 'manifest' : 'files')) {
      if (process.env.SKILL_STARTER) { state.assets[name] = ''; state.starters = { [name]: 701 }; }
      code = 1; break;
    }
    state.assets[name] = fs.readFileSync(file, 'utf8');
  }
} else if (command === 'download') {
  const name = option('--pattern');
  if (!(name in state.assets) || (state.starters?.[name] && process.env.SKILL_STARTER === 'unavailable')) code = 1;
  else fs.writeFileSync(path.join(option('--dir'), name), state.assets[name]);
} else if (command === 'edit') {
  if (args.includes('--draft=false')) state.draft = false;
  if (args.includes('--prerelease=true')) state.prerelease = true;
  if (args.includes('--prerelease=false')) state.prerelease = false;
} else code = 2;
if (state.exists && !state.draft && !['skill--SKILL.md', 'skill--references--auth.md', 'install.sh', 'skill-manifest.tsv'].every(a => a in state.assets)) state.incompleteVisible = true;
fs.writeFileSync('state.json', JSON.stringify(state));
process.exit(code);
`, { mode: 0o755 });
    const invoke = (fail = "") => {
      let code = 0, stderr = "";
      try {
        execFileSync("bash", ["-e", "-o", "pipefail", "-c", publish], {
          cwd: root, stdio: "pipe", env: { ...process.env, PATH: path.join(root, "bin") + path.delimiter + process.env.PATH,
            GITHUB_REF_NAME: tag, SKILL_FAIL_UPLOAD: fail, SKILL_STARTER: options.starter ?? "", SKILL_OVERLAP: options.overlap ?? "" },
        });
      } catch (error) { const failure = error as { status: number; stderr: Buffer }; code = failure.status; stderr = failure.stderr.toString(); }
      return { code, stderr, state: JSON.parse(readFileSync(path.join(root, "state.json"), "utf8")) as ReleaseState };
    };
    const attempts = [invoke(options.fail)];
    if (options.starter) {
      attempts.push(invoke()); // A retry alone cannot replace the reserved filename.
      const cleaned = attempts.at(-1)!.state;
      const manual = structuredClone(cleaned);
      for (const name of Object.keys(manual.starters!)) delete manual.assets[name];
      delete manual.starters; // Simulate the documented operator cleanup, outside the publisher.
      writeFileSync(path.join(root, "state.json"), JSON.stringify(manual));
      attempts.push(invoke());
    }
    return { ...attempts.at(-1)!, assets, attempts };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("skill release publication", () => {
  it.each(["files", "manifest"].flatMap(fail => ["empty", "unavailable"].map(starter => ({ fail: fail as "files" | "manifest", starter: starter as "empty" | "unavailable" }))))("diagnoses a persistent starter after a failed $fail upload ($starter download)", options => {
    const result = run(options);
    for (const attempt of result.attempts.slice(0, 2)) {
      expect(attempt.code).not.toBe(0);
      expect(attempt.state.draft).toBe(true);
      expect(attempt.state.starters).toBeDefined();
      expect(attempt.stderr).toContain("starter");
      expect(attempt.stderr).toContain("Stop all publishers");
      expect(attempt.stderr).toContain("still a draft");
      expect(attempt.stderr).toContain("releases/assets/701");
    }
    expect(result.code).toBe(0);
    expect(result.state.assets).toEqual(result.assets);
    expect(result.state.calls.some(c => c.includes("DELETE") || c.includes("--clobber"))).toBe(false);
    expect(result.state.publicAssetMutation).toBe(false);
  });

  it.each([false, true])("sets existing draft classification from the tag (prerelease=%s)", prerelease => {
    const result = run({ existing: "draft", prerelease, draftPrerelease: !prerelease });
    expect(result.code).toBe(0);
    expect(result.state.prerelease).toBe(prerelease);
    expect(result.state.draft).toBe(false);
  });

  it.each(["missing", "corrupt", "wrong-tag", "checksum", "unsafe-path"] as const)("rejects a %s distribution before contacting GitHub", invalid => {
    const result = run({ invalid });
    expect(result.code).not.toBe(0);
    expect(result.state.calls).toEqual([]);
  });

  it("serializes the entire release workflow per repository and tag without cancellation", () => {
    expect(workflow.concurrency?.group).toBe("release-${{ github.repository }}-${{ github.ref }}");
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it.each([undefined, "files"] as const)("preserves public assets when publishers overlap (upload failure=%s)", fail => {
    const result = run({ existing: "draft", overlap: "upload", fail });
    expect(result.state.overlapStarted).toBe(true);
    expect(result.state.overlappingPublisherStatus).toBe(0);
    expect(result.state.publicAssetMutation).toBe(false);
    expect(result.state.incompleteVisible).toBe(false);
    expect(result.state.assets).toEqual(result.assets);
    expect(result.code).toBe(0);
  });

  it("verifies a release created and published by an overlapping invocation", () => {
    const result = run({ overlap: "create" });
    expect(result.state.overlappingPublisherStatus).toBe(0);
    expect(result.code).toBe(0);
    expect(result.state.draft).toBe(false);
    expect(result.state.publicAssetMutation).toBe(false);
    expect(result.state.incompleteVisible).toBe(false);
    expect(result.state.assets).toEqual(result.assets);
  });

  it("refuses to replace a differing draft asset", () => {
    const result = run({ existing: "draft", modified: true });
    expect(result.code).not.toBe(0);
    expect(result.state.draft).toBe(true);
    expect(result.state.assets["skill--SKILL.md"]).toBe("published content");
  });

  it("bounds the distribution job", () => {
    expect(workflow.jobs.skills["timeout-minutes"]).toBeGreaterThan(0);
    expect(workflow.jobs.skills["timeout-minutes"]).toBeLessThanOrEqual(15);
  });

  it.each([false, true])("publishes only complete assets (prerelease=%s)", prerelease => {
    const result = run({ prerelease });
    expect(result.code).toBe(0);
    expect(result.state.draft).toBe(false);
    expect(result.state.prerelease).toBe(prerelease);
    expect(result.state.assets).toEqual(result.assets);
    expect(result.state.incompleteVisible).toBe(false);
  });

  it.each(["files", "manifest"] as const)("keeps a draft when the %s upload fails", fail => {
    const result = run({ fail });
    expect(result.code).not.toBe(0);
    expect(result.state.draft).toBe(true);
    expect(result.state.incompleteVisible).toBe(false);
  });

  it("resumes an incomplete draft", () => {
    const result = run({ existing: "draft", missing: true });
    expect(result.code).toBe(0);
    expect(result.state.draft).toBe(false);
    expect(result.state.assets).toEqual(result.assets);
    expect(result.state.incompleteVisible).toBe(false);
  });

  it("verifies a completed release without mutating it on retry", () => {
    const result = run({ existing: "published" });
    expect(result.code).toBe(0);
    expect(result.state.calls.some(c => ["create", "upload", "edit"].includes(c[1]))).toBe(false);
  });

  it.each([{ missing: true }, { modified: true }])("refuses to overwrite an inconsistent public release: %j", inconsistency => {
    const result = run({ existing: "published", ...inconsistency });
    expect(result.code).not.toBe(0);
    expect(result.state.calls.some(c => ["upload", "edit"].includes(c[1]))).toBe(false);
  });
});
