import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, getUserByVerifiedEmail, rbacQuery, setUserDisabled, upsertUser } from "@/lib/db";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "oidc-cutover-"));
  process.env.ARTIFACT_DATA_DIR = dataDir;
});
afterEach(async () => {
  await closeDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ARTIFACT_DATA_DIR;
  vi.restoreAllMocks();
});

it("keeps the same internal account when Logto changes subject for a verified email", async () => {
  const old = await upsertUser({
    authProvider: "oidc", providerSubject: "old-subject",
    email: "Person@Example.com", emailVerified: true,
  });
  const migrated = await upsertUser({
    authProvider: "oidc", providerSubject: "new-subject",
    email: "person@example.com", emailVerified: true,
    displayName: "New profile", migrateVerifiedEmail: true,
  });
  expect(migrated.id).toBe(old.id);
  expect(migrated.created).toBe(false);
  expect(migrated.providerSubject).toBe("new-subject");
  expect(migrated.displayName).toBe("New profile");
});

it("does not migrate an account from an unverified email", async () => {
  const old = await upsertUser({
    authProvider: "oidc", providerSubject: "old-unverified-subject",
    email: "incoming-unverified@example.com", emailVerified: true,
  });
  const next = await upsertUser({
    authProvider: "oidc", providerSubject: "new-unverified-subject",
    email: "incoming-unverified@example.com", emailVerified: false, migrateVerifiedEmail: true,
  });
  expect(next.id).not.toBe(old.id);
  expect(next.created).toBe(true);
});

it("does not migrate from a stored unverified email", async () => {
  const old = await upsertUser({
    authProvider: "oidc", providerSubject: "stored-unverified-old",
    email: "stored-unverified@example.com", emailVerified: false,
  });
  const next = await upsertUser({
    authProvider: "oidc", providerSubject: "stored-unverified-new",
    email: "stored-unverified@example.com", emailVerified: true, migrateVerifiedEmail: true,
  });
  expect(next.id).not.toBe(old.id);
});

it("does not migrate a verified email from another provider", async () => {
  const other = await upsertUser({
    authProvider: "other", providerSubject: "other-provider",
    email: "cross-provider@example.com", emailVerified: true,
  });
  const oidc = await upsertUser({
    authProvider: "oidc", providerSubject: "oidc-provider",
    email: "cross-provider@example.com", emailVerified: true, migrateVerifiedEmail: true,
  });
  expect(oidc.id).not.toBe(other.id);
});

it("initializes a legacy account tenant while preserving its disabled state", async () => {
  const old = await upsertUser({
    authProvider: "oidc", providerSubject: "legacy-old",
    email: "legacy@example.com", emailVerified: true,
  });
  await setUserDisabled(old.id, Date.now(), "disabled before cutover");
  await rbacQuery("DELETE FROM tenant_members WHERE user_id=$1", [old.id]);
  await rbacQuery("UPDATE users SET tenant_id=NULL WHERE id=$1", [old.id]);
  const migrated = await upsertUser({
    authProvider: "oidc", providerSubject: "legacy-new",
    email: "legacy@example.com", emailVerified: true, migrateVerifiedEmail: true,
  });
  expect(migrated.id).toBe(old.id);
  expect(migrated.tenantId).toBe("init");
  expect(migrated.disabledReason).toBe("disabled before cutover");
  expect(await rbacQuery("SELECT user_id FROM tenant_members WHERE tenant_id='init' AND user_id=$1", [old.id]))
    .toEqual([{ user_id: old.id }]);
});

it("migrates the earliest account when a verified email belongs to multiple accounts", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const earliest = await upsertUser({ authProvider: "oidc", providerSubject: "a", email: "duplicate@example.com", emailVerified: true });
  await new Promise((resolve) => setTimeout(resolve, 2));
  await upsertUser({ authProvider: "oidc", providerSubject: "b", email: "DUPLICATE@example.com", emailVerified: true });
  const migrated = await upsertUser({
    authProvider: "oidc", providerSubject: "new-duplicate-subject",
    email: "duplicate@example.com", emailVerified: true, migrateVerifiedEmail: true,
  });
  expect(migrated.id).toBe(earliest.id);
  expect(migrated.providerSubject).toBe("new-duplicate-subject");
  expect((await getUserByVerifiedEmail("DUPLICATE@example.com"))?.id).toBe(earliest.id);
  expect(info).toHaveBeenCalledWith("[oidc-account-migration]", expect.any(String));
  const logPayload = info.mock.calls[0][1] as string;
  expect(logPayload).not.toContain("\n");
  expect(JSON.parse(logPayload)).toEqual(expect.objectContaining({
    userId: earliest.id, oldSubject: "a", newSubject: "new-duplicate-subject",
  }));
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][1]).toBe(logPayload);
  const repeat = await upsertUser({
    authProvider: "oidc", providerSubject: "new-duplicate-subject",
    email: "duplicate@example.com", emailVerified: true, migrateVerifiedEmail: true,
  });
  expect(repeat.id).toBe(earliest.id);
  expect(info).toHaveBeenCalledTimes(1);
});

it("resolves email lookups by creation time rather than insertion order", async () => {
  const first = await upsertUser({ authProvider: "oidc", providerSubject: "lookup-first", email: "lookup@example.com", emailVerified: true });
  const second = await upsertUser({ authProvider: "oidc", providerSubject: "lookup-second", email: "lookup@example.com", emailVerified: true });
  await rbacQuery("UPDATE users SET created_at=$1 WHERE id=$2", [first.createdAt - 1, second.id]);
  expect((await getUserByVerifiedEmail("LOOKUP@example.com"))?.id).toBe(second.id);
});
