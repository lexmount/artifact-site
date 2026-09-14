// Token storage is per server. The bug this pins: two deployments sharing one token file meant
// every switch between them overwrote the other's token, so every new session asked to sign in.
import { mkdtemp, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearToken, hostKey, readToken, writeToken, writeStoredConfig } from "../src/config.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ah-cfg-"));
  process.env.ARTIFACT_SITE_CONFIG_DIR = dir;
  delete process.env.ARTIFACT_SITE_TOKEN;
});
afterEach(() => { delete process.env.ARTIFACT_SITE_CONFIG_DIR; delete process.env.ARTIFACT_SITE_TOKEN; });

const A = "https://a.example";
const B = "http://b.example:8080/";

describe("per-host tokens", () => {
  it("two servers keep two tokens; signing in on one never touches the other", async () => {
    writeToken(A, "ahp_a");
    writeToken(B, "ahp_b");
    expect(readToken(A)).toBe("ahp_a");
    expect(readToken(B)).toBe("ahp_b");
    expect(existsSync(path.join(dir, "tokens", "a.example"))).toBe(true);
    expect(existsSync(path.join(dir, "tokens", "b.example_8080"))).toBe(true);
    expect(((await stat(path.join(dir, "tokens", "a.example"))).mode & 0o777)).toBe(0o600);
    clearToken(A);
    expect(readToken(A)).toBeNull();
    expect(readToken(B)).toBe("ahp_b");
  });

  it("the environment wins over every file — a sandbox with a fresh HOME stays signed in that way", () => {
    writeToken(A, "ahp_file");
    process.env.ARTIFACT_SITE_TOKEN = "ahp_env";
    expect(readToken(A)).toBe("ahp_env");
  });

  it("a legacy single-file token is adopted under the host it was recorded for, and only that host", async () => {
    await writeFile(path.join(dir, "token"), "ahp_legacy\n");
    writeStoredConfig({ baseUrl: A });
    expect(readToken(B)).toBeNull();                 // not B's: config.json says the file was A's
    expect(existsSync(path.join(dir, "token"))).toBe(true);
    expect(readToken(A)).toBe("ahp_legacy");         // adopted …
    expect(existsSync(path.join(dir, "token"))).toBe(false);   // … and the single file is gone
    expect(await readFile(path.join(dir, "tokens", "a.example"), "utf8")).toBe("ahp_legacy");
  });

  it("a legacy file with no recorded server is assumed to be for whichever server asks first", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "token"), "ahp_old");
    expect(readToken(B)).toBe("ahp_old");
    expect(existsSync(path.join(dir, "tokens", "b.example_8080"))).toBe(true);
  });

  it("hostKey is a safe file name", () => {
    expect(hostKey("https://Hub.Example:8443/some/path")).toBe("hub.example_8443");
    expect(hostKey("http://127.0.0.1:4300")).toBe("127.0.0.1_4300");
  });
});

describe("the previous name (artifact-hub) keeps working", () => {
  it("ARTIFACT_HUB_TOKEN / ARTIFACT_HUB_URL are honoured when the new names are unset", async () => {
    const { readToken, resolveBaseUrl } = await import("../src/config.js");
    const saved = { ...process.env };
    try {
      delete process.env.ARTIFACT_SITE_TOKEN; delete process.env.ARTIFACT_SITE_URL;
      process.env.ARTIFACT_HUB_TOKEN = "ahp_from_old_name";
      process.env.ARTIFACT_HUB_URL = "https://old.example/";
      expect(readToken("https://old.example")).toBe("ahp_from_old_name");
      expect(resolveBaseUrl()).toBe("https://old.example");
      process.env.ARTIFACT_SITE_TOKEN = "ahp_new_wins";
      expect(readToken("https://old.example")).toBe("ahp_new_wins");
    } finally { process.env = saved; }
  });

  it("a token stored under ~/.config/artifact-hub/tokens/<host> is found and adopted; the old copy stays", async () => {
    const { mkdtemp, mkdir, writeFile, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { readToken, hostKey } = await import("../src/config.js");
    const home = await mkdtemp(path.join(tmpdir(), "ah-rename-"));
    const saved = { ...process.env };
    try {
      process.env.XDG_CONFIG_HOME = home;
      delete process.env.ARTIFACT_SITE_CONFIG_DIR; delete process.env.ARTIFACT_HUB_CONFIG_DIR;
      delete process.env.ARTIFACT_SITE_TOKEN; delete process.env.ARTIFACT_HUB_TOKEN;
      const host = hostKey("https://hub.example");
      await mkdir(path.join(home, "artifact-hub", "tokens"), { recursive: true });
      await writeFile(path.join(home, "artifact-hub", "tokens", host), "ahp_renamed\n");
      expect(readToken("https://hub.example")).toBe("ahp_renamed");
      expect(await readFile(path.join(home, "artifact-site", "tokens", host), "utf8")).toBe("ahp_renamed");
      expect(await readFile(path.join(home, "artifact-hub", "tokens", host), "utf8")).toBe("ahp_renamed\n");
      // Logout must reach the old copy too, or the next command would adopt it again.
      const { clearToken } = await import("../src/config.js");
      clearToken("https://hub.example");
      expect(readToken("https://hub.example")).toBeNull();
      expect(existsSync(path.join(home, "artifact-hub", "tokens", host))).toBe(false);
      // Same for the old single-file token.
      await writeFile(path.join(home, "artifact-hub", "token"), "ahp_single");
      expect(readToken("https://hub.example")).toBe("ahp_single");
      clearToken("https://hub.example");
      expect(readToken("https://hub.example")).toBeNull();
    } finally { process.env = saved; }
  });
});

