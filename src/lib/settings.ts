import "server-only";

// Policy an operator may change from the console, without a rebuild. Six settings, all of them
// "who may do what": create policy, what anonymous creators may do, default visibility, the
// anonymous-site clock, and the four quota caps. Everything that would need a restart or could
// lock the operator out (database, storage, OIDC, the public address, the administrator list)
// stays in the environment on purpose.
//
// Precedence, per key: console (the settings table) > environment variable > built-in default.
// The environment keeps working exactly as before, so a Docker/.env deployment notices nothing;
// a console value simply sits on top, and "reset" takes it off again.
//
// Reads are synchronous — these values are consulted in the middle of authorization and upload
// paths that have no business awaiting a query — so the console layer is a cached snapshot of the
// table, refreshed in the background at most every REFRESH_MS, and refreshed on the spot by the
// replica that saved a change. Other replicas follow within REFRESH_MS. The environment layer is
// read live on every call (it is the fallback, and tests flip it per case).
//
// `scope` is the seat reserved for tenants: today every row is "global"; a tenant's row of the
// same key would override it, and the resolution below is where that one extra lookup goes.
import { config } from "@/lib/config";
import { listSettings, onDbCloseForTests, writeSettings } from "@/lib/db";
import type { SettingRow } from "@/lib/types";
import { BadRequestError } from "@/lib/errors";

export const GLOBAL_SCOPE = "global";
const REFRESH_MS = 30_000;

export type CreatePolicy = "open" | "login" | "token";
export type AnonymousSites = "full" | "read-only";
export type Visibility = "public" | "unlisted" | "private";

export interface PolicySettings {
  createPolicy: CreatePolicy;
  anonymousSites: AnonymousSites;
  defaultVisibility: Visibility;
  anonSiteTtlDays: number;
  quotaSitesPerUser: number;
  quotaBytesPerUser: number;
  quotaSitesPerAnon: number;
  quotaBytesPerAnon: number;
}
export type SettingKey = keyof PolicySettings;

type Kind = { kind: "enum"; options: readonly string[] } | { kind: "int"; min: number; max: number };

/** The catalogue: how each key is validated, and what the environment says for it. */
export const SETTINGS: { [K in SettingKey]: Kind & { env: string; fromEnv: () => PolicySettings[K] } } = {
  createPolicy: { kind: "enum", options: ["open", "login", "token"], env: "ARTIFACT_CREATE_POLICY", fromEnv: () => config.createPolicy },
  anonymousSites: { kind: "enum", options: ["full", "read-only"], env: "ARTIFACT_ANONYMOUS_SITES", fromEnv: () => config.anonymousSites },
  defaultVisibility: { kind: "enum", options: ["public", "unlisted", "private"], env: "ARTIFACT_DEFAULT_VISIBILITY", fromEnv: () => config.defaultVisibility },
  anonSiteTtlDays: { kind: "int", min: 0, max: 3650, env: "ARTIFACT_ANON_SITE_TTL_DAYS", fromEnv: () => Math.round(config.anonSiteTtlMs / 86_400_000) },
  quotaSitesPerUser: { kind: "int", min: 0, max: 1_000_000, env: "ARTIFACT_QUOTA_SITES_PER_USER", fromEnv: () => config.quota.sitesPerUser },
  quotaBytesPerUser: { kind: "int", min: 0, max: Number.MAX_SAFE_INTEGER, env: "ARTIFACT_QUOTA_BYTES_PER_USER", fromEnv: () => config.quota.bytesPerUser },
  quotaSitesPerAnon: { kind: "int", min: 0, max: 1_000_000, env: "ARTIFACT_QUOTA_SITES_PER_ANON", fromEnv: () => config.quota.sitesPerAnon },
  quotaBytesPerAnon: { kind: "int", min: 0, max: Number.MAX_SAFE_INTEGER, env: "ARTIFACT_QUOTA_BYTES_PER_ANON", fromEnv: () => config.quota.bytesPerAnon },
};
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

// --- the console layer: a snapshot of the table ------------------------------------------

let stored: Partial<Record<SettingKey, unknown>> = {};
let storedRows: Partial<Record<SettingKey, SettingRow>> = {};
let loadedAt = 0;
let inflight: Promise<void> | null = null;
onDbCloseForTests(() => { stored = {}; storedRows = {}; loadedAt = 0; inflight = null; });

/** One read of the table becomes the snapshot: parsed values, and the rows for their timestamps. */
function adopt(rows: SettingRow[]): void {
  const values: Partial<Record<SettingKey, unknown>> = {};
  const byKey: Partial<Record<SettingKey, SettingRow>> = {};
  for (const row of rows) {
    if (!(row.key in SETTINGS)) continue; // a key from a newer or older build: ignore, never fail
    try { values[row.key as SettingKey] = JSON.parse(row.value); } catch { continue; } // unreadable row: ignore
    byKey[row.key as SettingKey] = row;
  }
  stored = values;
  storedRows = byKey;
  loadedAt = Date.now();
}

/** Re-read the console layer now. Used at boot, after a save, and by the background refresh. */
export async function refreshSettings(): Promise<void> {
  if (!inflight) {
    inflight = (async () => {
      try { adopt(await listSettings(GLOBAL_SCOPE)); }
      finally { inflight = null; }
    })();
  }
  return inflight;
}

function snapshot(refresh: boolean): Partial<Record<SettingKey, unknown>> {
  if (refresh && Date.now() - loadedAt > REFRESH_MS) void refreshSettings().catch(() => {}); // stale: refresh behind the read
  return stored;
}

function validate<K extends SettingKey>(key: K, value: unknown): PolicySettings[K] {
  const def = SETTINGS[key];
  if (def.kind === "enum") {
    if (typeof value !== "string" || !def.options.includes(value)) throw new BadRequestError(`${key}: expected one of ${def.options.join(" / ")}`);
    return value as PolicySettings[K];
  }
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < def.min || n > def.max) throw new BadRequestError(`${key}: expected a whole number between ${def.min} and ${def.max}`);
  return n as PolicySettings[K];
}

/** Effective value of one key: console, else environment (which already folds in the default).
 *  `refresh: false` reads whatever snapshot is loaded without touching the database — for the boot
 *  check, which runs before (or instead of) a working database. */
export function setting<K extends SettingKey>(key: K, refresh = true): PolicySettings[K] {
  const fromConsole = snapshot(refresh)[key];
  if (fromConsole !== undefined) {
    try { return validate(key, fromConsole); } catch { /* a row this build no longer accepts: fall through */ }
  }
  return SETTINGS[key].fromEnv();
}

function policyView(refresh: boolean) {
  return {
    get createPolicy(): CreatePolicy { return setting("createPolicy", refresh); },
    get anonymousSites(): AnonymousSites { return setting("anonymousSites", refresh); },
    get defaultVisibility(): Visibility { return setting("defaultVisibility", refresh); },
    get anonSiteTtlMs(): number { return setting("anonSiteTtlDays", refresh) * 86_400_000; },
    get quota(): { sitesPerUser: number; bytesPerUser: number; sitesPerAnon: number; bytesPerAnon: number } {
      return { sitesPerUser: setting("quotaSitesPerUser", refresh), bytesPerUser: setting("quotaBytesPerUser", refresh), sitesPerAnon: setting("quotaSitesPerAnon", refresh), bytesPerAnon: setting("quotaBytesPerAnon", refresh) };
    },
  };
}

/** The whole effective policy, as the code paths consume it (keeps the snapshot fresh in the background). */
export const policy = policyView(true);
/** The same, for the boot check: reads the loaded snapshot and never starts a database read. */
export const bootPolicy = policyView(false);

// --- the console's view and its writes ----------------------------------------------------

export interface SettingView {
  key: SettingKey;
  kind: Kind["kind"];
  options?: readonly string[];
  /** What the code actually uses right now. */
  value: string | number;
  /** Where that value comes from. */
  source: "console" | "environment";
  /** What the environment (or the default) would give if the console value were removed. */
  envValue: string | number;
  /** The environment variable an operator would set instead. */
  env: string;
  updatedAt: number | null;
}

export async function describeSettings(): Promise<SettingView[]> {
  await refreshSettings(); // values and timestamps below come from this one read
  return SETTING_KEYS.map((key) => {
    const def = SETTINGS[key];
    const fromConsole = stored[key];
    let consoleValue: string | number | undefined;
    if (fromConsole !== undefined) { try { consoleValue = validate(key, fromConsole); } catch { consoleValue = undefined; } }
    const envValue = def.fromEnv();
    return {
      key, kind: def.kind, ...(def.kind === "enum" ? { options: def.options } : {}),
      value: consoleValue ?? envValue, source: consoleValue !== undefined ? "console" : "environment",
      envValue, env: def.env, updatedAt: storedRows[key]?.updatedAt ?? null,
    };
  });
}

/**
 * Apply a batch from the console: `null` clears a key back to the environment. Every value is
 * validated before anything is written, and the writes land in one transaction, so a bad batch —
 * or a failing one — changes nothing. Returns the keys whose stored value actually changed:
 * re-saving a form as it stands is a no-op and leaves no log row behind.
 */
export async function updateSettings(values: Partial<Record<SettingKey, unknown>>, updatedBy: string | null): Promise<SettingKey[]> {
  const wanted: Array<[SettingKey, PolicySettings[SettingKey] | null]> = [];
  for (const [k, v] of Object.entries(values)) {
    if (!(k in SETTINGS)) throw new BadRequestError(`Unknown setting: ${k}`);
    const key = k as SettingKey;
    wanted.push([key, v === null || v === undefined || v === "" ? null : validate(key, v)]);
  }
  loadedAt = 0;
  await refreshSettings(); // compare against what is stored NOW, not a snapshot up to 30 s old
  const writes = wanted
    .filter(([key, value]) => (value === null ? key in stored : JSON.stringify(stored[key]) !== JSON.stringify(value)))
    .map(([key, value]) => ({ key, value: value === null ? null : JSON.stringify(value) }));
  if (writes.length === 0) return [];
  await writeSettings(GLOBAL_SCOPE, writes, updatedBy, Date.now());
  loadedAt = 0;
  await refreshSettings();
  return writes.map((w) => w.key as SettingKey);
}
