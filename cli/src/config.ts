// Where the CLI keeps its identity. Deliberately the same files the agent skill (/for-agents.md)
// tells agents to use, so a token obtained by either is usable by both:
//   ~/.config/artifact-site/tokens/<host>  the publish token for ONE server (plain text, mode 0600)
//   ~/.config/artifact-site/config.json    { "baseUrl": "...", "email": "..." }  the default server
//   ~/.config/artifact-site/token          legacy single-server file; read once and moved into tokens/
// Tokens are per server: one obtained on a.example is unknown on b.example. Keeping them in one file
// meant every switch between two deployments overwrote the other's token — the "why do I have to
// sign in again every session" bug. Environment variables win over files: ARTIFACT_SITE_URL,
// ARTIFACT_SITE_TOKEN (the latter is how a sandbox with a fresh HOME every session stays signed in).
// The previous name's variables (ARTIFACT_HUB_*) and directory (~/.config/artifact-hub) are still
// read, so a rename never costs anyone a sign-in.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface StoredConfig {
  baseUrl?: string;
  email?: string;
}

export function configDir(): string {
  return process.env.ARTIFACT_SITE_CONFIG_DIR || process.env.ARTIFACT_HUB_CONFIG_DIR
    || path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "artifact-site");
}

/**
 * Where the CLI kept its files under its previous name; read (never written) so nobody signs in
 * again over a rename. Only when the directory is the default one: an explicit config directory
 * (the environment override) is the whole world, and must never reach into the user's real home.
 */
function legacyConfigDir(): string | null {
  if (process.env.ARTIFACT_SITE_CONFIG_DIR || process.env.ARTIFACT_HUB_CONFIG_DIR) return null;
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "artifact-hub");
}

/** `https://hub.example:8443/x` → `hub.example_8443`: a file name, one per server, no path tricks. */
export function hostKey(baseUrl: string): string {
  const host = new URL(baseUrl).host.toLowerCase();
  return host.replace(/[^a-z0-9.\-]/g, "_");
}

const legacyTokenPath = () => path.join(configDir(), "token");
const tokenPath = (baseUrl: string) => path.join(configDir(), "tokens", hostKey(baseUrl));
const configPath = () => path.join(configDir(), "config.json");

export function readStoredConfig(): StoredConfig {
  const old = legacyConfigDir();
  for (const file of [configPath(), ...(old ? [path.join(old, "config.json")] : [])]) {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as StoredConfig;
    } catch { /* next */ }
  }
  return {};
}

export function writeStoredConfig(next: StoredConfig): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ ...readStoredConfig(), ...next }, null, 2) + "\n");
}

function readFileToken(file: string): string | null {
  try {
    const t = readFileSync(file, "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

/** Same host as the legacy file was written for, as far as config.json remembers; unknown = assume yes (the file predates the record). */
function legacyBelongsTo(baseUrl: string): boolean {
  const recorded = readStoredConfig().baseUrl;
  if (!recorded) return true;
  try { return hostKey(recorded) === hostKey(baseUrl); } catch { return false; }
}

/** The token for THIS server: environment, then tokens/<host>, then the legacy single file (moved into place on first use). */
export function readToken(baseUrl: string): string | null {
  const env = process.env.ARTIFACT_SITE_TOKEN || process.env.ARTIFACT_HUB_TOKEN;
  if (env) return env;
  const own = readFileToken(tokenPath(baseUrl));
  if (own) return own;
  // The same per-host file under the previous name: adopted into place, the old copy left alone.
  const old = legacyConfigDir();
  const renamed = old ? readFileToken(path.join(old, "tokens", hostKey(baseUrl))) : null;
  if (renamed) {
    writeToken(baseUrl, renamed);
    return renamed;
  }
  const legacy = readFileToken(legacyTokenPath()) ?? (old ? readFileToken(path.join(old, "token")) : null);
  if (legacy && legacyBelongsTo(baseUrl)) {
    // Adopt it under its host, so a second server's login can no longer clobber it.
    writeToken(baseUrl, legacy);
    rmSync(legacyTokenPath(), { force: true }); // the old-name directory's copy is left as it was
    return legacy;
  }
  return null;
}

export function writeToken(baseUrl: string, token: string): void {
  const file = tokenPath(baseUrl);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Created with mode 0600 from the first byte (no window where another user could read it),
  // then renamed into place so a crash mid-write never leaves a half-written token behind.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, token, { mode: 0o600 });
  renameSync(tmp, file);
}

export function clearToken(baseUrl: string): void {
  const file = tokenPath(baseUrl);
  if (existsSync(file)) rmSync(file);
  // A legacy file for this same server is this server's token too.
  if (existsSync(legacyTokenPath()) && legacyBelongsTo(baseUrl)) rmSync(legacyTokenPath());
  // And the copies under the previous name — readToken adopts them, so a logout that left them
  // behind would sign the user straight back in on the next command.
  const old = legacyConfigDir();
  if (old) {
    rmSync(path.join(old, "tokens", hostKey(baseUrl)), { force: true });
    if (existsSync(path.join(old, "token")) && legacyBelongsTo(baseUrl)) rmSync(path.join(old, "token"), { force: true });
  }
}

/** The deployment to talk to. `--base` on the command line beats the environment, which beats the file. */
export function resolveBaseUrl(explicit?: string): string | null {
  const raw = explicit || process.env.ARTIFACT_SITE_URL || process.env.ARTIFACT_HUB_URL || readStoredConfig().baseUrl || "";
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  // The value becomes the target of every request and the `Origin` we claim; only http(s) makes sense.
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { throw new Error(`Base URL is not a valid URL: ${trimmed}`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`Base URL must start with http:// or https://: ${trimmed}`);
  return trimmed;
}
