// scripts/await-cli-on-npm.sh gates the MCP Registry publish on the CLI package being on npm WITH
// the `mcpName` the registry checks. Driven here with a fake `npm` on PATH whose registry is a
// file, so the outcomes that matter are pinned: it waits for a version that is not there yet, it
// passes once the version carries the right mcpName, a version that is on npm without it (the
// forgotten bump) fails at once with the fix, a failed lookup is retried rather than read as
// "no mcpName", and it gives up after ATTEMPTS.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/await-cli-on-npm.sh", import.meta.url));
const SERVER = "io.github.lexmount/artifact-site";

interface Fake {
  /** What the fake registry has: version → mcpName, or null for a version published without one. */
  registry: Record<string, string | null>;
  /** The first N `npm view … version` lookups say the version is not there (it arrives later). */
  arrivesAfter?: number;
  /** The first N `npm view … mcpName` lookups fail (network), before answering. */
  mcpNameFails?: number;
  attempts?: number;
}

function run(version: string, fake: Fake): { code: number; out: string; calls: string[] } {
  const root = mkdtempSync(path.join(tmpdir(), "await-cli-"));
  try {
    const pkg = path.join(root, "cli"); mkdirSync(pkg);
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@artifact-site/cli", version }));
    const serverJson = path.join(root, "server.json");
    writeFileSync(serverJson, JSON.stringify({ name: SERVER, version: "0.0.0" }));
    const registry = path.join(root, "registry");
    writeFileSync(registry, Object.entries(fake.registry).map(([v, m]) => `${v} ${m ?? "-"}\n`).join(""));
    const state = path.join(root, "state"); mkdirSync(state);
    const log = path.join(root, "calls.log");
    const bin = path.join(root, "bin"); mkdirSync(bin);
    // `npm view <name@version> version` exits 0 once the version is there; `npm view <name@version> mcpName`
    // prints the field (nothing when the version has none) and exits 0, exactly as npm does.
    writeFileSync(path.join(bin, "npm"), `#!/usr/bin/env bash
echo "$*" >> "${log}"
[ "$1" = view ] || exit 2
ver="\${2##*@}"; field="$3"
line="$(grep -m1 "^$ver " "${registry}" || true)"
count() { n=$(( $(cat "${state}/$1" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${state}/$1"; echo "$n"; }
case "$field" in
  version) n="$(count version)"; if [ -n "$line" ] && [ "$n" -gt ${fake.arrivesAfter ?? 0} ]; then echo "$ver"; exit 0; fi; exit 1 ;;
  mcpName) n="$(count mcpName)"; if [ "$n" -le ${fake.mcpNameFails ?? 0} ]; then exit 1; fi; m="\${line#* }"; [ "$m" = "-" ] || echo "$m"; exit 0 ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
    let code = 0, out = "";
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ATTEMPTS: String(fake.attempts ?? 5), SLEEP_SECONDS: "0" };
    try {
      out = execFileSync("bash", [script, pkg, serverJson], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) { const err = e as { status: number; stdout: string; stderr: string }; code = err.status; out = `${err.stdout}${err.stderr}`; }
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
    return { code, out, calls };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const versionLookups = (calls: string[]) => calls.filter((c) => c.endsWith(" version")).length;
const mcpNameLookups = (calls: string[]) => calls.filter((c) => c.endsWith(" mcpName")).length;

describe("scripts/await-cli-on-npm.sh", () => {
  it("waits for the version, then passes once it is on npm with the registry's mcpName", () => {
    const r = run("0.4.0", { registry: { "0.4.0": SERVER }, arrivesAfter: 2 });
    expect(r.code).toBe(0);
    expect(r.out).toContain("waiting for @artifact-site/cli@0.4.0 on npm (2/5)");
    expect(r.out).toContain(`@artifact-site/cli@0.4.0 is on npm with mcpName ${SERVER}`);
    expect(versionLookups(r.calls)).toBe(3);
    expect(mcpNameLookups(r.calls)).toBe(1);
  });

  it("fails at once, naming the fix, when the version is on npm without mcpName (the forgotten bump)", () => {
    const r = run("0.3.0", { registry: { "0.3.0": null } });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`@artifact-site/cli@0.3.0 is on npm with mcpName '<none>', not ${SERVER}`);
    expect(r.out).toMatch(/Bump the version in .*package\.json and tag again/);
    expect(r.out).not.toContain("waiting");
    expect(versionLookups(r.calls)).toBe(1);
    expect(mcpNameLookups(r.calls)).toBe(1);
  });

  it("rejects a version whose mcpName is another server's", () => {
    const r = run("0.4.0", { registry: { "0.4.0": "io.github.someone/else" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`is on npm with mcpName 'io.github.someone/else', not ${SERVER}`);
  });

  it("retries a failed mcpName lookup instead of reading it as no mcpName", () => {
    const r = run("0.4.0", { registry: { "0.4.0": SERVER }, mcpNameFails: 1, attempts: 3 });
    expect(r.code).toBe(0);
    expect(versionLookups(r.calls)).toBe(2);
    expect(mcpNameLookups(r.calls)).toBe(2);
  });

  it("gives up after ATTEMPTS when the version never appears", () => {
    const r = run("0.4.0", { registry: {}, attempts: 2 });
    expect(r.code).toBe(1);
    expect(r.out).toContain("waiting for @artifact-site/cli@0.4.0 on npm (2/2)");
    expect(r.out).toContain("@artifact-site/cli@0.4.0 did not appear on npm within 0 seconds");
    expect(versionLookups(r.calls)).toBe(2);
    expect(mcpNameLookups(r.calls)).toBe(0);
  });
});
