// Environment configuration. Getters read process.env lazily so tests can toggle at runtime.
// Server-only: this module reaches the database / object store / secrets, and must never be
// bundled into a client component. The import is a build-time tripwire (see next.js docs).
import "server-only";
import path from "node:path";

const projectRoot = process.cwd();

function absoluteFromProject(value: string): string {
  return path.isAbsolute(value) ? value : path.join(/* turbopackIgnore: true */ projectRoot, value);
}

/**
 * Every path this app serves an OIDC callback on. The first is canonical; the rest are aliases
 * kept because an IdP registration already points at them. Adding an entry here without adding
 * the matching route file would advertise a redirect_uri that 404s, so the two must move together.
 */
export const OIDC_CALLBACK_PATHS = ["/api/auth/callback", "/v1/access/auth/oauth/callback"] as const;

function csv(value: string | undefined): string[] {
  return (value || "").split(",").map((part) => part.trim()).filter(Boolean);
}

/** Positive integer from env, else the default. Requires all-digits so "50MB" doesn't silently
 *  parse to 50 (a 50-byte cap that rejects everything) — a nasty operator footgun. */
function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) return fallback; // reject "50MB", "1_000", etc. — use raw byte counts
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Upload limits — a dropped site is finished, not a monorepo. Getters so a self-hosted
// operator can raise them via env without rebuilding (defaults unchanged).
export const limits = {
  // HTML with video is a normal size, not an anomaly: a clip a few minutes long starts at 100MB.
  // Only with the ceiling raised to 300MB (250MB per file) can such projects really be hosted.
  //
  // Raising it is safe because **the upload path no longer reads files into memory**: large projects
  // go through the chunked streaming channel at /api/uploads, and the server holds one buffer at a
  // time. Raising these two numbers before that was dangerous — production was in fact crashed by a
  // large upload (process restart, everyone 503 meanwhile). The numbers and that channel are one
  // package and should not be tuned separately.
  get maxBytes(): number { return intFromEnv("ARTIFACT_MAX_BYTES", 300 * 1024 * 1024); }, // the whole version
  get maxFiles(): number { return intFromEnv("ARTIFACT_MAX_FILES", 2000); },
  get maxFileBytes(): number { return intFromEnv("ARTIFACT_MAX_FILE_BYTES", 250 * 1024 * 1024); }, // a single file
  /**
   * The line the one-shot upload (the old path, everything into memory) still holds. Anything over
   * it must go through the chunked channel. This is not a "limit" but a "protection": without it, a
   * 300MB multipart would blow up the process during formData parsing — raising the ceiling makes
   * the crash easier, not harder.
   */
  get inlineUploadMaxBytes(): number { return intFromEnv("ARTIFACT_INLINE_UPLOAD_MAX_BYTES", 24 * 1024 * 1024); },
};

// Per-client token bucket for write routes (create / fork / edit). In-memory by design. In a
// multi-replica deploy (postgres + s3) it is per-process, so the aggregate cap is ~N× the config
// under N replicas — acceptable internally; use a shared limiter only if a precise global cap is
// needed. `burst` = max requests in a spike; `perMin` = sustained refill rate.
export const rateLimit = {
  get enabled(): boolean {
    const raw = process.env.ARTIFACT_RATE_LIMIT;
    if (raw) return raw.toLowerCase() !== "off";
    // Default on in production; off under the test runner, where integration tests create many
    // sites in a burst under one client key. This is the one default that still consults VITEST
    // directly rather than test/setup.ts, because tests that exercise the limiter flip it per
    // case with ARTIFACT_RATE_LIMIT=on and a setup-time value would have to be undone by each.
    return !process.env.VITEST;
  },
  get burst(): number { return intFromEnv("ARTIFACT_RATE_LIMIT_BURST", 20); },
  get perMin(): number { return intFromEnv("ARTIFACT_RATE_LIMIT_PER_MIN", 30); },
  get maxKeys(): number { return intFromEnv("ARTIFACT_RATE_LIMIT_MAX_KEYS", 10_000); }, // hard cap on tracked clients
};

// One line per process, not per request: the enforceOwnership getter runs on every call.
const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[config] ${message}`);
}

/** Forget which warnings were already printed, so a test can assert on one that an earlier test
 *  (or an earlier case in the same file) has already triggered. Tests only. */
export function __resetWarnedForTests(): void {
  warned.clear();
}

export const config = {
  get previewSigningSecret(): string { return process.env.PREVIEW_SIGNING_SECRET?.trim() || ""; },
  /** Root of all on-disk state: sites/<siteId>/<versionId>/… (and the test suite's sqlite file). */
  get dataDir(): string {
    return absoluteFromProject(process.env.ARTIFACT_DATA_DIR || ".data");
  },
  /** Empty = dev/test mode (auth disabled); set = Bearer token required on every mutation route. */
  /**
   * Administrators, by verified sign-in e-mail (lower-cased). Empty means the console is closed;
   * PUBLISH_API_TOKEN as a Bearer is still an administrator for scripts. There is deliberately no
   * "first account becomes admin": this product often runs on the open internet with anonymous
   * publishing on, and a race for the first sign-in is not a policy.
   */
  get adminEmails(): ReadonlySet<string> {
    return new Set(csv(process.env.ARTIFACT_ADMIN_EMAILS).map((e) => e.toLowerCase()));
  },
  /** How long a deleted site's files are kept for restore before they are purged. Default 30 days; 0 purges at the next maintenance run. */
  get deletedRetentionMs(): number {
    // Not intFromEnv: that helper treats 0 as "unset", and 0 is a legitimate value here.
    const raw = (process.env.ARTIFACT_DELETED_RETENTION_DAYS || "").trim();
    const days = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 30;
    return days * 24 * 60 * 60 * 1000;
  },
  /**
   * Per-owner caps, all off (0) by default so an upgrade changes nothing. Recommended on any
   * deployment that lets strangers publish. Anonymous browsers are identified by their cookie id,
   * which anyone can reset — the anonymous caps stop the naive case, not a determined one; the
   * anonymous site expiry is the real backstop there.
   */
  get quota(): { sitesPerUser: number; bytesPerUser: number; sitesPerAnon: number; bytesPerAnon: number } {
    return {
      sitesPerUser: intFromEnv("ARTIFACT_QUOTA_SITES_PER_USER", 0),
      bytesPerUser: intFromEnv("ARTIFACT_QUOTA_BYTES_PER_USER", 0),
      sitesPerAnon: intFromEnv("ARTIFACT_QUOTA_SITES_PER_ANON", 0),
      bytesPerAnon: intFromEnv("ARTIFACT_QUOTA_BYTES_PER_ANON", 0),
    };
  },
  /**
   * What the browser that created a site anonymously may do with it before anyone signs in.
   * `full` (default): it is the owner — edit, share, delete. `read-only`: it may only open the
   * site; every other action asks for a sign-in, after which the site is the account's. Needs
   * ownership enforcement to mean anything (the legacy regime has no notion of "the creator").
   */
  get anonymousSites(): "full" | "read-only" {
    return (process.env.ARTIFACT_ANONYMOUS_SITES || "").trim().toLowerCase() === "read-only" ? "read-only" : "full";
  },
  /** Audit retention: 0 keeps records forever. Invalid values fail safe to no deletion. */
  get auditRetentionDays(): number {
    const raw = process.env.ARTIFACT_AUDIT_RETENTION_DAYS ?? "0";
    const days = /^\d+$/.test(raw) ? Number(raw) : NaN;
    return Number.isInteger(days) && days >= 0 && days <= 3650 ? days : 0;
  },
  /** How long a site published without an account lives after its last change; 0 = forever (the default). Claiming it ends the clock. */
  get anonSiteTtlMs(): number {
    return intFromEnv("ARTIFACT_ANON_SITE_TTL_DAYS", 0) * 24 * 60 * 60 * 1000;
  },
  get publishApiToken(): string {
    return process.env.PUBLISH_API_TOKEN || "";
  },
  /** Optional connect-src allowlist appended to the sandbox CSP on served HTML (empty = bare sandbox). */
  get cspConnectSrc(): string[] {
    return csv(process.env.CSP_CONNECT_SRC);
  },
  /**
   * Which storage backend persists version files: "local" or "s3" (COS-compatible).
   *
   * Explicit `ARTIFACT_STORAGE_DRIVER` wins. Unset, the choice follows the credentials: a bucket
   * name means the operator wants the bucket, nothing means the local disk under dataDir. One
   * knob fewer to keep in sync — the failure mode this removes is "filled in the S3 block, forgot
   * the switch, files silently went to the container disk". The test suite sets the driver
   * explicitly (test/setup.ts) so the inference never runs there: a developer's shell may carry
   * real COS credentials for the gated integration test, and the unit suite must never follow
   * them into a live bucket.
   */
  get storageDriver(): string {
    const explicit = (process.env.ARTIFACT_STORAGE_DRIVER || "").trim().toLowerCase();
    if (explicit) return explicit;
    return (process.env.ARTIFACT_S3_BUCKET || "").trim() ? "s3" : "local";
  },
  /** Gotenberg endpoint for office→pdf document previews. Empty (default) = conversion off:
   *  office uploads still publish, as download cards — dev needs no extra service running. */
  get gotenbergUrl(): string {
    return (process.env.GOTENBERG_URL || "").trim().replace(/\/+$/, "");
  },
  /** TOTAL budget for one office→pdf preview: queue wait + the conversion itself share it, so a
   *  burst can never hold an upload past the gateway's patience — the tail degrades to download
   *  cards instead. LibreOffice on a normal deck finishes in single-digit seconds. */
  get convertTimeoutMs(): number {
    return intFromEnv("ARTIFACT_CONVERT_TIMEOUT_MS", 60_000);
  },
  /** Simultaneous conversions per app process; excess uploads queue FIFO (bounded at 10× this —
   *  beyond that new uploads degrade to the card immediately; conversion is CPU-bound on the
   *  Gotenberg side, and unbounded fan-out just makes every conversion slower than the cap). */
  get convertConcurrency(): number {
    return Math.max(1, intFromEnv("ARTIFACT_CONVERT_CONCURRENCY", 2));
  },
  /** Canonical public origin, e.g. https://artifacts.example.net. Used to derive the OIDC redirect
   *  URI and to check Origin on cookie-authenticated writes. Empty falls back to the request origin,
   *  which is fine locally but should always be set behind a proxy. */
  get publicUrl(): string {
    return (process.env.ARTIFACT_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  },
  /** Origin of the optional embedded assistant SDK (an external AI panel), e.g. https://assistant.example.com.
   *  Empty (default) = the floating assistant is off — most deployments have nothing to embed, so
   *  the switch and the address are one setting. */
  get assistantUrl(): string {
    // ARTIFACT_CLOUDDESK_URL is the pre-1.0 name; still honoured so existing deployments keep working.
    return (process.env.ARTIFACT_ASSISTANT_URL || process.env.ARTIFACT_CLOUDDESK_URL || "").trim().replace(/\/+$/, "");
  },
  /**
   * Visibility a brand-new site is born with. Two postures:
   *
   *   public    open. A link is a link: whoever has it can open it, and it is listed in the home directory. (intranet, internal use)
   *   private   cautious. The canonical link is a 404 for everyone until the owner explicitly shares it. (public internet)
   *
   * `ARTIFACT_DEFAULT_VISIBILITY` decides. Unset, the only thing inferred is "is this a local
   * checkout": no ARTIFACT_PUBLIC_URL means somebody is running it on their laptop, and defaulting
   * that to private would make every site invisible the moment they open a clean browser. Any
   * deployment with a public URL defaults to the cautious posture — an intranet deployment says
   * `public` explicitly. (This used to sniff a company hostname; a self-hosted product cannot.)
   *
   * Only the DEFAULT moves. Once a site's visibility is set, both postures read it the same way
   * (lib/share.canReadSite), and existing rows are untouched.
   */
  get defaultVisibility(): "public" | "unlisted" | "private" {
    const explicit = (process.env.ARTIFACT_DEFAULT_VISIBILITY || "").trim().toLowerCase();
    if (explicit === "public" || explicit === "unlisted" || explicit === "private") return explicit;
    return this.publicUrl === "" ? "public" : "private";
  },
  /** OIDC relying-party settings. Endpoints are discovered from the issuer, so only these three
   *  are configured; the redirect URI is derived from publicUrl and must match the IdP whitelist. */
  get oidc(): { issuer: string; clientId: string; clientSecret: string } {
    return {
      issuer: (process.env.ARTIFACT_OIDC_ISSUER || "").trim().replace(/\/+$/, ""),
      clientId: (process.env.ARTIFACT_OIDC_CLIENT_ID || "").trim(),
      clientSecret: (process.env.ARTIFACT_OIDC_CLIENT_SECRET || "").trim(),
    };
  },
  /**
   * Path appended to publicUrl to form the redirect_uri sent to the IdP. It must be one of
   * OIDC_CALLBACK_PATHS, because the redirect_uri has to match a route that actually exists —
   * a free-form value would hand the IdP an address that 404s, and the failure would only ever
   * show up as a dead login. Configurable at all because the IdP-side registration belongs to an
   * administrator, and some registrations were made against the alias path before the canonical
   * one existed.
   */
  get oidcRedirectPath(): string {
    const raw = (process.env.ARTIFACT_OIDC_REDIRECT_PATH || "").trim();
    if (!raw) return OIDC_CALLBACK_PATHS[0];
    if ((OIDC_CALLBACK_PATHS as readonly string[]).includes(raw)) return raw;
    warnOnce(
      `ARTIFACT_OIDC_REDIRECT_PATH=${raw} is invalid; falling back to ${OIDC_CALLBACK_PATHS[0]}. ` +
      `It must be one of the callback routes this app actually serves: ${OIDC_CALLBACK_PATHS.join(" / ")}.`,
    );
    return OIDC_CALLBACK_PATHS[0];
  },
  get oidcEnabled(): boolean {
    const o = this.oidc;
    return Boolean(o.issuer && o.clientId && o.clientSecret);
  },
  /**
   * The OAuth authorization server for remote MCP clients (lib/oauth). `clientHosts` limits which
   * hosts may identify themselves — metadata-document client_ids and every redirect_uri — to a
   * listed host or a subdomain of one; empty means any public https host, the default, because a
   * self-hosted deployment gains nothing from refusing a client the signed-in person is about to
   * approve on the consent page anyway. `dcrEnabled` switches the unauthenticated registration
   * endpoint (RFC 7591); metadata-document clients (ChatGPT's preferred method) work either way.
   */
  get oauth(): { clientHosts: ReadonlySet<string>; dcrEnabled: boolean; appSchemes: ReadonlySet<string> } {
    return {
      clientHosts: new Set(csv(process.env.ARTIFACT_OAUTH_CLIENT_HOSTS).map((host) => host.toLowerCase())),
      dcrEnabled: (process.env.ARTIFACT_OAUTH_DCR || "").trim().toLowerCase() !== "off",
      /** Application schemes admitted as redirect addresses on top of the built-in shape (lib/oauth-clients). */
      appSchemes: new Set(csv(process.env.ARTIFACT_OAUTH_APP_SCHEMES).map((scheme) => scheme.toLowerCase())),
    };
  },
  /**
   * Who may create a site: open | login | token.
   *
   * Defaults FAIL-CLOSED. Before identity existed, setting PUBLISH_API_TOKEN was the only way to
   * lock down creation, so a deployment relying on that must not silently become world-writable
   * the moment it upgrades. Hence: token set and no explicit policy ⇒ "token", not "open".
   */
  get createPolicy(): "open" | "login" | "token" {
    const raw = (process.env.ARTIFACT_CREATE_POLICY || "").trim().toLowerCase();
    if (raw === "open" || raw === "login" || raw === "token") return raw;
    return this.publishApiToken ? "token" : "open";
  },
  /** @deprecated RBAC is always enforced; retained as a read-only compatibility value. */
  get enforceOwnership(): boolean { return true; },
  /**
   * Which metadata store to use. Postgres is the only production store; "sqlite" exists solely
   * as the test suite's backend (no external service needed to run `npm test`) and is refused
   * outside the test runner — see lib/db.getStore and lib/runtime.validateRuntime, which are
   * the two places that enforce it (per request, and at boot). Explicit `ARTIFACT_DB_DRIVER`
   * still wins so an existing deployment env stays valid; unset means postgres. The test suite
   * asks for sqlite explicitly (test/setup.ts) rather than this getter knowing about vitest.
   */
  get dbDriver(): string {
    const explicit = (process.env.ARTIFACT_DB_DRIVER || "").trim().toLowerCase();
    if (explicit) return explicit;
    return "postgres";
  },
  /** True only where the sqlite backend may be used at all. This guard legitimately looks at the
   *  test runner itself: it exists to refuse `ARTIFACT_DB_DRIVER=sqlite` on a real host, and an
   *  env variable a deployment could set cannot be what proves it is not a real host. */
  get sqliteAllowed(): boolean {
    return Boolean(process.env.VITEST);
  },
  /** Postgres connection string (required whenever dbDriver === "postgres"). */
  get databaseUrl(): string {
    return process.env.ARTIFACT_DATABASE_URL || "";
  },
  /** S3/COS backend settings (used only when storageDriver === "s3"). */
  get s3(): {
    endpoint: string; region: string; bucket: string;
    accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean; cacheBytes: number;
  } {
    return {
      endpoint: process.env.ARTIFACT_S3_ENDPOINT || "",
      region: process.env.ARTIFACT_S3_REGION || "us-east-1",
      bucket: process.env.ARTIFACT_S3_BUCKET || "",
      accessKeyId: process.env.ARTIFACT_S3_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.ARTIFACT_S3_SECRET_ACCESS_KEY || "",
      forcePathStyle: (process.env.ARTIFACT_S3_FORCE_PATH_STYLE || "false").toLowerCase() === "true",
      cacheBytes: intFromEnv("ARTIFACT_S3_CACHE_BYTES", 128 * 1024 * 1024), // preview read cache ceiling
    };
  },
};

export function dataPath(...parts: string[]): string {
  return path.join(/* turbopackIgnore: true */ config.dataDir, ...parts);
}
