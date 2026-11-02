import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it.each([
  ["upgrade", "0", "0"],
  ["upgradecn", "0", "0"],
  ["upgradecn", "1", "0"],
  ["upgradecn", "0", "1"],
])("%s preserves the subpath and stops on failure (git=%s, build=%s)", (target, gitStatus, buildStatus) => {
  const dir = mkdtempSync(path.join(tmpdir(), "artifact-upgrade-"));
  try {
    for (const name of ["Makefile", "scripts", "compose", "config"]) {
      cpSync(name, path.join(dir, name), { recursive: true });
    }
    const envText = "ARTIFACT_PUBLIC_URL=https://hub.example.test/artifact-site\nARTIFACT_BASE_PATH=/artifact-site\nARTIFACT_DATABASE_URL=postgres://test:test@db/test\n";
    writeFileSync(path.join(dir, ".env"), envText);
    const log = path.join(dir, "calls.jsonl");
    const stub = `#!${process.execPath}
const fs = require('node:fs');
const command = require('node:path').basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({command, args, basePath: process.env.ARTIFACT_BASE_PATH || '', publicUrl: process.env.ARTIFACT_PUBLIC_URL || ''}) + '\\n');
if (command === 'git') process.exit(Number(process.env.GIT_STATUS));
if (args[0] === 'compose' && args[1] === 'version') console.log('2.30.0');
if (args[0] === 'version') console.log('27.0.0');
if (args[0] === 'inspect') console.log(args[2].includes('Health') ? 'healthy' : 'running');
if (args[0] === 'compose' && args.includes('build')) process.exit(Number(process.env.BUILD_STATUS));
`;
    for (const name of ["git", "docker"]) writeFileSync(path.join(dir, name), stub, { mode: 0o755 });
    const result = spawnSync("make", [target], {
      cwd: dir, env: { NODE_ENV: "test", PATH: `${dir}:${process.env.PATH}`, CALL_LOG: log, GIT_STATUS: gitStatus, BUILD_STATUS: buildStatus },
      encoding: "utf8", timeout: 15_000,
    });
    const calls: { command: string; args: string[]; basePath: string; publicUrl: string }[] =
      readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(calls[0]).toMatchObject({ command: "git", args: ["pull", "--ff-only"] });
    expect(readFileSync(path.join(dir, ".env"), "utf8")).toBe(envText);
    const build = calls.find(call => call.args.includes("build"));
    if (gitStatus === "1") expect(build).toBeUndefined();
    else {
      expect(build).toMatchObject({ basePath: "/artifact-site", publicUrl: "https://hub.example.test/artifact-site" });
      expect(build?.args.includes("USE_CN_MIRROR=1")).toBe(target === "upgradecn");
    }
    const failed = gitStatus === "1" || buildStatus === "1";
    expect(result.status === 0, result.stdout + result.stderr).toBe(!failed);
    expect(calls.some(call => call.args.includes("up"))).toBe(!failed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
