import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const prepare = path.resolve("scripts/prepare-cli-release.sh");
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "cli-release-"));
  const cwd = path.join(root, "checkout");
  const remote = path.join(root, "remote.git");
  mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Release Test", "-c", "user.email=release@example.test", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "--bare", remote);
  git("init", "-b", "main");
  git("remote", "add", "origin", remote);
  mkdirSync(path.join(cwd, "cli"));
  writeFileSync(path.join(cwd, "cli/package.json"), JSON.stringify({ version: "0.6.0" }));
  git("add", ".");
  git("commit", "-s", "-m", "test: release fixture");
  const output = path.join(root, "output");
  const run = () => spawnSync("bash", [prepare], { cwd, env: { ...process.env, GITHUB_OUTPUT: output }, encoding: "utf8" });
  return { root, cwd, git, run, output };
}

it("pins a new CLI tag and reuses exactly the same commit on retry", () => {
  const f = fixture();
  try {
    expect(f.run().status).toBe(0);
    expect(f.git("ls-remote", "origin", "refs/tags/v0.6.0").split(/\s/)[0]).toBe(f.git("rev-parse", "HEAD"));
    expect(readFileSync(f.output, "utf8")).toBe("tag=v0.6.0\n");
    expect(f.run().status).toBe(0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it("refuses an existing release tag at a different commit", () => {
  const f = fixture();
  try {
    expect(f.run().status).toBe(0);
    const pinned = f.git("rev-parse", "HEAD");
    f.git("commit", "--allow-empty", "-s", "-m", "test: later commit");
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("already points to another commit");
    expect(f.git("ls-remote", "origin", "refs/tags/v0.6.0").split(/\s/)[0]).toBe(pinned);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it("rejects invalid CLI versions before creating tags", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.cwd, "cli/package.json"), JSON.stringify({ version: "0.6.0/invalid" }));
    expect(f.run().status).not.toBe(0);
    expect(f.git("ls-remote", "--tags", "origin")).toBe("");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it("builds CLI distributions without replacing deployment documentation", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cli-distribution-"));
  try {
    for (const dir of ["scripts", "cli", "src/content"]) mkdirSync(path.join(root, dir), { recursive: true });
    cpSync("skills", path.join(root, "skills"), { recursive: true });
    for (const name of ["build-skill-package.mjs", "install-skill.sh"]) copyFileSync("scripts/" + name, path.join(root, "scripts", name));
    writeFileSync(path.join(root, "cli/package.json"), JSON.stringify({ version: "0.6.0" }));
    const guide = path.join(root, "src/content/publish-skill.md");
    writeFileSync(guide, "Keep the deployed compatibility guide.\n");
    const args = ["scripts/build-skill-package.mjs", "--check", "--npm", "--distribution-only", "--release", "v0.6.0"];
    execFileSync(process.execPath, args, { cwd: root, stdio: "pipe" });
    expect(readFileSync(guide, "utf8")).toBe("Keep the deployed compatibility guide.\n");
    expect(readFileSync(path.join(root, "cli/skill/manifest.tsv"), "utf8")).toBe(readFileSync(path.join(root, "dist-skill/skill-manifest.tsv"), "utf8"));
    writeFileSync(path.join(root, "skills/artifact-site/references/unindexed.md"), "Unexpected");
    expect(() => execFileSync(process.execPath, args, { cwd: root, stdio: "pipe" })).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("keeps manual CLI publication separate from server images", () => {
  const { load } = createRequire(import.meta.url)("js-yaml");
  const workflow = load(readFileSync(".github/workflows/release.yml", "utf8"));
  expect(workflow.on).toHaveProperty("workflow_dispatch");
  expect(workflow.jobs.image.if).toContain("github.event_name == 'push'");
  expect(workflow.jobs.distribution.if).toContain("github.event_name == 'workflow_dispatch'");
  expect(workflow.jobs.distribution.permissions).toEqual({ contents: "write", "id-token": "write" });
  const steps = workflow.jobs.distribution.steps.map((s: { run?: string }) => s.run ?? "").join("\n");
  expect(steps.indexOf("prepare-cli-release.sh")).toBeLessThan(steps.indexOf("publish-cli.sh"));
  expect(steps.indexOf("publish-cli.sh")).toBeLessThan(steps.indexOf("publish-skill.sh"));
});
