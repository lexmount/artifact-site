// scripts/publish-cli.sh is the release workflow's publish step. It is driven here with a fake
// `npm` on PATH that records what it was asked to do, so the three outcomes that matter are pinned:
// a version npm already has is left alone, a stable version is published to `latest`, and a
// prerelease is published to `next` (npm refuses a prerelease without an explicit tag).
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/publish-cli.sh", import.meta.url));

/** Run the script against a package of `version`; `published` is what the fake registry already has. */
function run(version: string, published: string[]): { code: number; out: string; calls: string[] } {
  const root = mkdtempSync(path.join(tmpdir(), "publish-cli-"));
  try {
    const pkg = path.join(root, "pkg"); mkdirSync(pkg);
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@artifact-site/cli", version }));
    const bin = path.join(root, "bin"); mkdirSync(bin);
    const log = path.join(root, "calls.log");
    // `npm view <name@version> version` exits 0 when the fake registry has it; `npm publish` records its arguments.
    writeFileSync(path.join(bin, "npm"), `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$1" in
  view) for p in ${published.map((v) => `"@artifact-site/cli@${v}"`).join(" ")}; do [ "$2" = "$p" ] && exit 0; done; exit 1 ;;
  publish) exit 0 ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
    let code = 0, out = "";
    try {
      out = execFileSync("bash", [script, pkg], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) { const err = e as { status: number; stdout: string; stderr: string }; code = err.status; out = `${err.stdout}${err.stderr}`; }
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
    return { code, out, calls };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("scripts/publish-cli.sh", () => {
  it("leaves a version npm already has alone", () => {
    const r = run("0.1.0", ["0.1.0"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("already on npm");
    expect(r.calls.filter((c) => c.startsWith("publish"))).toEqual([]);
  });

  it("publishes a stable version to latest, with provenance", () => {
    const r = run("0.2.0", ["0.1.0"]);
    expect(r.code).toBe(0);
    expect(r.calls).toContain("publish --provenance --access public");
    expect(r.calls.some((c) => c.includes("--tag"))).toBe(false);
  });

  it("publishes a prerelease to the next tag", () => {
    const r = run("0.2.0-rc.1", ["0.1.0"]);
    expect(r.code).toBe(0);
    expect(r.calls).toContain("publish --provenance --access public --tag next");
  });

  it("refuses a version that is not semver before touching npm", () => {
    const r = run("0.2", []);
    expect(r.code).toBe(1);
    expect(r.out).toContain("not a semver string");
    expect(r.calls).toEqual([]);
  });
});
