// Backend selection rules and the boot check that enforces them.
//
// Postgres is the only production metadata store; sqlite exists for this suite alone. Storage
// follows the credentials unless an explicit driver says otherwise. These tests pin both rules
// from outside the test runner's point of view by clearing VITEST for the duration of a case —
// config reads env lazily, so that is enough to see what production would see.
import { afterEach, describe, expect, it } from "vitest";
import { config } from "@/lib/config";
import { closeDbForTests, getSite } from "@/lib/db";
import { describeRuntime, redactDatabaseUrl } from "@/lib/runtime";

const KEYS = [
  "VITEST", "ARTIFACT_DB_DRIVER", "ARTIFACT_DATABASE_URL", "ARTIFACT_STORAGE_DRIVER",
  "ARTIFACT_S3_BUCKET", "ARTIFACT_S3_ENDPOINT", "ARTIFACT_S3_ACCESS_KEY_ID", "ARTIFACT_S3_SECRET_ACCESS_KEY",
  "ARTIFACT_PUBLIC_URL", "ARTIFACT_CREATE_POLICY", "ARTIFACT_OIDC_ISSUER", "ARTIFACT_OIDC_CLIENT_ID",
  "ARTIFACT_OIDC_CLIENT_SECRET", "PUBLISH_API_TOKEN",
] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

function production(env: Record<string, string>): void {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
}

afterEach(async () => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await closeDbForTests();
});

describe("metadata driver", () => {
  it("uses the sqlite that test/setup.ts asks for, and postgres when nothing is set", () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(process.env.ARTIFACT_DB_DRIVER).toBe("sqlite"); // set by test/setup.ts, not inferred
    expect(config.dbDriver).toBe("sqlite");
    production({});
    expect(config.dbDriver).toBe("postgres");
    expect(config.sqliteAllowed).toBe(false);
  });

  it("honours an explicit ARTIFACT_DB_DRIVER=postgres under vitest (the live integration test relies on it)", () => {
    process.env.ARTIFACT_DB_DRIVER = "postgres";
    expect(config.dbDriver).toBe("postgres");
  });

  it("refuses sqlite outside the test runner at the store boundary", async () => {
    await closeDbForTests();
    production({ ARTIFACT_DB_DRIVER: "sqlite" });
    await expect(getSite("nope")).rejects.toThrow(/test runner only/);
  });

  it("boot check: sqlite outside the test runner is a fatal error, postgres without a URL is a fatal error", () => {
    production({ ARTIFACT_DB_DRIVER: "sqlite" });
    expect(describeRuntime().errors.join("\n")).toMatch(/test runner only/);
    production({});
    expect(describeRuntime().errors.join("\n")).toMatch(/ARTIFACT_DATABASE_URL is empty/);
    production({ ARTIFACT_DATABASE_URL: "postgres://u:p@db:5432/x" });
    expect(describeRuntime().errors).toEqual([]);
  });
});

describe("storage driver", () => {
  it("follows the bucket in production, stays local under the test runner", () => {
    process.env.ARTIFACT_S3_BUCKET = "some-bucket";
    expect(config.storageDriver).toBe("local");
    production({ ARTIFACT_S3_BUCKET: "some-bucket" });
    expect(config.storageDriver).toBe("s3");
    production({});
    expect(config.storageDriver).toBe("local");
  });

  it("an explicit driver beats the inference", () => {
    production({ ARTIFACT_S3_BUCKET: "some-bucket", ARTIFACT_STORAGE_DRIVER: "local" });
    expect(config.storageDriver).toBe("local");
    const report = describeRuntime();
    expect(report.warnings.join("\n")).toMatch(/files will not go to the bucket/);
  });

  it("boot check: a bucket without the rest of the credentials is fatal, not a first-upload surprise", () => {
    production({ ARTIFACT_DATABASE_URL: "postgres://u:p@db:5432/x", ARTIFACT_S3_BUCKET: "b" });
    const report = describeRuntime();
    expect(report.errors.join("\n")).toMatch(/ARTIFACT_S3_ENDPOINT/);
    expect(report.errors.join("\n")).toMatch(/ARTIFACT_S3_SECRET_ACCESS_KEY/);
    production({
      ARTIFACT_DATABASE_URL: "postgres://u:p@db:5432/x", ARTIFACT_S3_BUCKET: "b",
      ARTIFACT_S3_ENDPOINT: "https://cos.example", ARTIFACT_S3_ACCESS_KEY_ID: "k", ARTIFACT_S3_SECRET_ACCESS_KEY: "s",
    });
    expect(describeRuntime().errors).toEqual([]);
    expect(describeRuntime().lines.join("\n")).toMatch(/files: s3 bucket b/);
  });
});

describe("boot report", () => {
  it("never prints the database password", () => {
    expect(redactDatabaseUrl("postgres://artifact_hub:s3cr3t@db:5432/artifact_hub?sslmode=disable"))
      .toBe("postgres://artifact_hub:***@db:5432/artifact_hub?sslmode=disable");
    expect(redactDatabaseUrl("not a url")).toBe("<unparseable>");
    production({ ARTIFACT_DATABASE_URL: "postgres://artifact_hub:s3cr3t@db:5432/artifact_hub" });
    expect(describeRuntime().lines.join("\n")).not.toContain("s3cr3t");
  });

  it("login policy without an IdP is fatal; open policy on a public address is a warning", () => {
    production({ ARTIFACT_DATABASE_URL: "postgres://u:p@db:5432/x", ARTIFACT_CREATE_POLICY: "login" });
    expect(describeRuntime().errors.join("\n")).toMatch(/all three OIDC settings/);
    production({ ARTIFACT_DATABASE_URL: "postgres://u:p@db:5432/x", ARTIFACT_PUBLIC_URL: "https://hub.example.com" });
    const report = describeRuntime();
    expect(report.errors).toEqual([]);
    expect(report.warnings.join("\n")).toMatch(/anyone who can reach the service can upload/);
  });
});
