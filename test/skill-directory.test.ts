import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { skillDirectory } from "../cli/src/skill-package";

const home = vi.hoisted(() => ({ directory: "" }));
vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), homedir: () => home.directory }));
const exec = promisify(execFile);
const variables = ["CODEX_THREAD_ID", "CLAUDECODE", "CURSOR_AGENT", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"];
let root: string;
let env: NodeJS.ProcessEnv;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "skill-target-"));
  home.directory = path.join(root, "user home");
  await mkdir(home.directory);
  await mkdir(path.join(root, "bin"));
  const hash = sha("# Skill");
  await writeFile(path.join(root, "manifest.tsv"), `format\t1\nrelease\tv0.6.0\nversion\t${sha(`SKILL.md\0${hash}\n`)}\nfile\t${hash}\tSKILL.md\n`);
  // check only fetches the manifest; a local executable replaces network transport.
  await writeFile(path.join(root, "bin/curl"), '#!/bin/sh\nprintf "called\\n" >> "$SKILL_TEST_REQUESTS"\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = --output ]; then cp "$SKILL_TEST_MANIFEST" "$2"; exit; fi\n  shift\ndone\nexit 1\n', { mode: 0o700 });
  env = { ...process.env, HOME: home.directory, PATH: path.join(root, "bin") + path.delimiter + process.env.PATH,
    SKILL_TEST_MANIFEST: path.join(root, "manifest.tsv"), SKILL_TEST_REQUESTS: path.join(root, "requests") };
  for (const key of variables) { vi.stubEnv(key, ""); delete env[key]; }
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

function set(key: string, value: string) { vi.stubEnv(key, value); env[key] = value; }
const shell = (...args: string[]) => exec("sh", ["scripts/install-skill.sh", "check", ...args], { env });
async function target(expected: string, agent?: string, directory?: string) {
  expect(skillDirectory(agent, directory)).toBe(expected);
  const args: string[] = [];
  if (agent) args.push("--agent", agent);
  if (directory) args.push("--dir", directory);
  const result = await shell(...args);
  expect(result.stdout.trim()).toMatch(/^missing [a-f0-9]{64} /);
  expect(result.stdout.trim().endsWith(" " + expected)).toBe(true);
}

describe("npm and shell skill destination selection", () => {
  it.each([
    ["CODEX_THREAD_ID", "session", ".codex"],
    ["CLAUDECODE", "1", ".claude"],
    ["CURSOR_AGENT", "1", ".cursor"],
  ])("uses the current %s session even when several clients are installed", async (key, value, directory) => {
    for (const config of [".codex", ".claude", ".cursor", ".config/opencode"]) await mkdir(path.join(home.directory, config), { recursive: true });
    set(key, value);
    await target(path.join(home.directory, directory, "skills/artifact-site"));
    expect(await readdir(path.join(home.directory, directory))).toEqual([]);
  });

  it.each([".codex", ".claude", ".cursor", ".config/opencode"])("uses the sole installed client at %s without session markers", async directory => {
    await mkdir(path.join(home.directory, directory), { recursive: true });
    await target(path.join(home.directory, directory, "skills/artifact-site"));
  });

  it.each([
    ["CODEX_HOME", "CODEX_THREAD_ID", "session", ""],
    ["CLAUDE_CONFIG_DIR", "CLAUDECODE", "1", ""],
    ["XDG_CONFIG_HOME", "", "", "opencode"],
  ])("respects custom %s configuration roots", async (key, marker, value, suffix) => {
    const config = path.join(root, "custom config");
    set(key, config);
    if (marker) set(marker, value);
    else await mkdir(path.join(config, suffix), { recursive: true });
    await target(path.join(config, suffix, "skills/artifact-site"));
  });

  it("keeps explicit overrides and rejects unknown agents", async () => {
    set("CODEX_THREAD_ID", "session");
    set("CLAUDECODE", "1");
    await target(path.join(home.directory, ".cursor/skills/artifact-site"), "cursor");
    await target(path.join(root, "explicit destination"), undefined, path.join(root, "explicit destination"));
    expect(() => skillDirectory("constructor")).toThrow(/Choose the current agent/);
    await expect(shell("--agent", "constructor")).rejects.toThrow(/Choose the current agent/);
  });

  it.each(["none", "multiple", "conflicting sessions"])("makes no installation when detection is %s", async mode => {
    if (mode === "multiple") for (const directory of [".codex", ".claude"]) await mkdir(path.join(home.directory, directory));
    if (mode === "conflicting sessions") { set("CODEX_THREAD_ID", "session"); set("CLAUDECODE", "1"); }
    const before = await readdir(home.directory);
    expect(() => skillDirectory()).toThrow(/--agent.*--dir/);
    await expect(shell()).rejects.toThrow(/--agent.*--dir/);
    expect(await readdir(home.directory)).toEqual(before);
    expect(await readdir(root)).not.toContain("requests");
  });

  it("preserves an unmanaged installation rather than choosing another client", async () => {
    set("CODEX_THREAD_ID", "session");
    const destination = path.join(home.directory, ".codex/skills/artifact-site");
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "SKILL.md"), "my local skill");
    expect(skillDirectory()).toBe(destination);
    await expect(shell()).rejects.toThrow(/unmanaged/);
    expect(await readFile(path.join(destination, "SKILL.md"), "utf8")).toBe("my local skill");
  });
});
