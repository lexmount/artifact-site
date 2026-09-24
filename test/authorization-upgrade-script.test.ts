import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

// Exercise the entire script without Docker or network access. The fake database keeps
// returning successful post-migration checks even if the restarted HTTP server fails.
function run(scenario: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "upgrade-script-"));
  const executable = (name: string, source: string) => writeFileSync(path.join(dir, name), `#!/bin/bash\n${source}\n`, { mode: 0o755 });
  executable("sleep", "exit 0");
  executable("docker", `case "$1" in
    port) if [[ -f "$UPGRADE_TEST_DIR/restarted" ]]; then echo '127.0.0.1:4301'; else echo '127.0.0.1:4300'; fi ;;
    restart) touch "$UPGRADE_TEST_DIR/restarted" ;;
    logs) echo 'fake container diagnostic' ;;
    exec)
      case "$*" in
        *'SELECT id FROM sites'*) echo site_test ;;
        *"WHERE id='initial'"*) echo 1 ;;
        *'SELECT COUNT('* ) echo 0 ;;
      esac ;;
  esac`);
  executable("curl", `if [[ -f "$UPGRADE_TEST_DIR/restarted" ]]; then
    if [[ "$*" != *':4301/'* ]]; then exit 22; fi
    if [[ "$UPGRADE_TEST_SCENARIO" == readiness-failure ]]; then exit 22; fi
    if [[ "$*" == *'/s/'* && "$UPGRADE_TEST_SCENARIO" == artifact-failure ]]; then exit 22; fi
  fi
  if [[ "$*" == *'/api/sites'* ]]; then echo '{"slug":"test"}'; else echo 'Upgrade retained'; fi`);
  try {
    return spawnSync("bash", ["scripts/test-authorization-upgrade.sh", "old", "new"], {
      encoding: "utf8", timeout: 10_000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, UPGRADE_TEST_DIR: dir, UPGRADE_TEST_SCENARIO: scenario },
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
it("fails without PASS when the restarted application never becomes ready", () => {
  const result = run("readiness-failure");
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain("PASS:");
  expect(result.stderr).toContain("fake container diagnostic");
});
it("fails without PASS when the original artifact is unavailable after restart", () => {
  const result = run("artifact-failure");
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain("PASS:");
});
it("reports success when startup, restart and artifact access succeed", () => {
  const result = run("success");
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("PASS:");
});
