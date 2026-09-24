// Boot-time picture of the deployment: which backends are in effect and whether the combination
// can work at all. Two consumers — instrumentation.ts prints it once per process and refuses to
// start on errors; `make doctor` reproduces the same rules in shell before a container is even
// created. Keep the two in step: a rule added here is a rule the operator should hear about before
// `make up`, not after.
//
// Why a boot check exists at all: every backend here initialises lazily, on the first real
// request. Without this, a mistyped variable name meant the app started clean and only failed —
// or, worse, silently used the wrong backend — the first time somebody uploaded.
import { config } from "@/lib/config";
import { bootPolicy as effective } from "@/lib/settings";

export interface RuntimeReport {
  /** Human-readable summary, one line per concern. */
  lines: string[];
  /** Misconfigurations the process must not start with. */
  errors: string[];
  /** Things that work but the operator probably did not intend. */
  warnings: string[];
}

/** `postgres://user:secret@host:5432/db` → `postgres://user:***@host:5432/db`. Never logs a secret. */
export function redactDatabaseUrl(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    // Not a URL at all: don't guess at where a password might sit, show nothing of it.
    return "<unparseable>";
  }
}

export function describeRuntime(): RuntimeReport {
  const lines: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- metadata ---------------------------------------------------------------
  const db = config.dbDriver;
  if (db === "postgres") {
    if (config.databaseUrl) lines.push(`metadata: postgres ${redactDatabaseUrl(config.databaseUrl)}`);
    else errors.push("Metadata needs Postgres, but ARTIFACT_DATABASE_URL is empty.");
  } else if (db === "sqlite") {
    if (config.sqliteAllowed) lines.push(`metadata: sqlite (test runner only) under ${config.dataDir}`);
    else errors.push("ARTIFACT_DB_DRIVER=sqlite is for the test runner only; production deployments must use Postgres: remove this variable and set ARTIFACT_DATABASE_URL.");
  } else {
    errors.push(`ARTIFACT_DB_DRIVER=${db} is not recognised; the only valid value is postgres.`);
  }

  // --- files ------------------------------------------------------------------
  const storage = config.storageDriver;
  if (storage === "s3") {
    const s3 = config.s3;
    const missing = [
      ["ARTIFACT_S3_ENDPOINT", s3.endpoint],
      ["ARTIFACT_S3_BUCKET", s3.bucket],
      ["ARTIFACT_S3_ACCESS_KEY_ID", s3.accessKeyId],
      ["ARTIFACT_S3_SECRET_ACCESS_KEY", s3.secretAccessKey],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) errors.push(`File storage is set to S3, but ${missing.join(" / ")} is missing.`);
    else lines.push(`files: s3 bucket ${s3.bucket} at ${s3.endpoint} (region ${s3.region})`);
  } else if (storage === "local") {
    lines.push(`files: local disk under ${config.dataDir}`);
    if ((process.env.ARTIFACT_S3_BUCKET || "").trim() && !process.env.VITEST) {
      warnings.push("ARTIFACT_S3_BUCKET is configured but ARTIFACT_STORAGE_DRIVER=local is set explicitly; files will not go to the bucket.");
    }
  } else {
    errors.push(`ARTIFACT_STORAGE_DRIVER=${storage} is not recognised; valid values are local or s3.`);
  }

  // --- who can do what ---------------------------------------------------------
  const publicUrl = config.publicUrl;
  lines.push(`public url: ${publicUrl || "(unset — derived from each request's Host)"}`);
  if (!publicUrl) warnings.push("ARTIFACT_PUBLIC_URL is not set: behind a reverse proxy, the OIDC callback, CSRF checks and the addresses in /for-agents.md are all derived from the request Host.");

  const policy = effective.createPolicy;
  lines.push(`create policy: ${policy}; anonymous creators: ${effective.anonymousSites}; default visibility: ${effective.defaultVisibility}; ownership enforced: yes (policy values may be overridden from the console; see /admin/settings)`);
  if (policy === "open" && publicUrl) {
    warnings.push("The create policy is open: anyone who can reach the service can upload. Fine for internal use; for public deployments set ARTIFACT_CREATE_POLICY=login or token.");
  }
  if (publicUrl && !(process.env.ARTIFACT_DEFAULT_VISIBILITY || "").trim()) {
    warnings.push(`ARTIFACT_DEFAULT_VISIBILITY is not set; new sites default to ${effective.defaultVisibility}. For internal use where links should open directly, set it to public explicitly.`);
  }
  if (policy === "login" && !config.oidcEnabled) {
    errors.push("ARTIFACT_CREATE_POLICY=login needs all three OIDC settings (ARTIFACT_OIDC_ISSUER / _CLIENT_ID / _CLIENT_SECRET); otherwise nobody can sign in, so nobody can create sites.");
  }
  lines.push(`administrators: ${config.adminEmails.size ? `${config.adminEmails.size} by e-mail` : "none by e-mail"}${config.publishApiToken ? " + the API token" : ""}; deleted sites kept ${Math.round(config.deletedRetentionMs / 86_400_000)} days`);
  {
    const q = effective.quota;
    const cap = (n: number, unit: string) => (n ? (unit === "B" ? (n >= 1048576 ? `${Math.round((n / 1048576) * 10) / 10}MB` : `${Math.round(n / 1024)}KB`) : String(n)) : "unlimited");
    lines.push(`quotas: per account ${cap(q.sitesPerUser, "")} sites / ${cap(q.bytesPerUser, "B")}; per anonymous browser ${cap(q.sitesPerAnon, "")} sites / ${cap(q.bytesPerAnon, "B")}; anonymous sites expire ${effective.anonSiteTtlMs ? `after ${Math.round(effective.anonSiteTtlMs / 86_400_000)} days without changes` : "never"}`);
  }
  lines.push(`oidc: ${config.oidcEnabled ? `on (${config.oidc.issuer}, callback ${config.oidcRedirectPath})` : "off"}`);
  {
    const o = effective.oauth;
    lines.push(`mcp oauth: clients from ${o.clientHosts.size ? [...o.clientHosts].join(",") : "any public https host"}; dynamic registration ${o.dcrEnabled ? "on" : "off"}; extra app schemes ${o.appSchemes.size ? [...o.appSchemes].join(",") : "none"} (console-editable; see /admin/settings)`);
  }
  lines.push(`document conversion: ${config.gotenbergUrl ? `gotenberg at ${config.gotenbergUrl}` : "off (office uploads become download cards)"}`);

  return { lines, errors, warnings };
}

/** Terminate the server process after a fatal configuration report (Node runtime only). */
export function exitOnFatalConfig(): never {
  process.exit(1);
}
