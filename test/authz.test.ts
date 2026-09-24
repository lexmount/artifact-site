import { resolveRole } from "./fixtures/authorization-role";
import { addCollaborator } from "./fixtures/legacy-identity";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveViewer } from "@/lib/authz";
import { closeDbForTests, createId, insertSiteWithVersion, upsertUser } from "@/lib/db";
import type { Session, Site } from "@/lib/types";

const dirs: string[] = [];

function site(over: Partial<Site> = {}): Site {
  return {
    tenantId: "init",
    id: "site_1", slug: "s1", title: "t", kind: "single", currentVersionId: "ver_1",
    createdAt: 1, updatedAt: 1, deletedAt: null, purgedAt: null, takenDownAt: null, takenDownReason: null,
    editToken: "legacy-token", ownerId: null, anonOwnerId: null, visibility: "public",
    ...over,
  };
}

function session(userId: string): Session {
  return {
    id: "ses_1", userId, oidcSid: null, createdAt: 1,
    expiresAt: Date.now() + 1e6, absoluteExpiresAt: Date.now() + 1e6,
    lastSeenAt: null, revokedAt: null, ip: null, userAgent: null,
  };
}

const req = (headers: Record<string, string> = {}) => new Request("https://x/api", { headers });

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "ah-authz-"));
  dirs.push(dir);
  process.env.ARTIFACT_DATA_DIR = dir;
});

afterEach(async () => {
  await closeDbForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.ARTIFACT_DATA_DIR;
  delete process.env.ARTIFACT_ENFORCE_OWNERSHIP;
  delete process.env.PUBLISH_API_TOKEN;
  for (const k of ["ARTIFACT_OIDC_ISSUER", "ARTIFACT_OIDC_CLIENT_ID", "ARTIFACT_OIDC_CLIENT_SECRET"]) delete process.env[k];
});

describe("account tenant boundaries", () => {
  it("an off switch cannot enable tokens on account-tenant orphans", async () => {
    const s = site();
    const withToken = resolveViewer(req({ "x-edit-token": "legacy-token" }));
    expect(await resolveRole(withToken, s)).toBe(null);

    const without = resolveViewer(req());
    expect(await resolveRole(without, s)).toBe(null);
  });

  it("rejects an owner identity without an active account and membership", async () => {
    const s = site({ ownerId: "usr_a" });
    const viewer = resolveViewer(req(), session("usr_a"));
    expect(await resolveRole(viewer, s)).toBe(null);
  });
});

describe("role authority", () => {
  beforeEach(() => {
    process.env.ARTIFACT_ENFORCE_OWNERSHIP = "on";
    process.env.ARTIFACT_OIDC_ISSUER = "https://idp.example/oidc";
    process.env.ARTIFACT_OIDC_CLIENT_ID = "cid";
    process.env.ARTIFACT_OIDC_CLIENT_SECRET = "secret";
  });

  it("denies every anonymous write, even with a valid legacy token", async () => {
    const s = site({});
    const viewer = resolveViewer(req({ "x-edit-token": "legacy-token" }));
    expect(await resolveRole(viewer, s)).toBe(null);
  });

  it("gives the owner full control", async () => {
    const user = await upsertUser({ authProvider: "test", providerSubject: "owner" });
    const s = site({ ownerId: user.id });
    expect(await resolveRole(resolveViewer(req(), session(user.id)), s)).toBe("owner");
  });

  it("stops a non-owner on an owner-only site", async () => {
    const s = site({ ownerId: "usr_a" });
    expect(await resolveRole(resolveViewer(req(), session("usr_b")), s)).toBe(null);
  });

  it("does not grant editing merely for signing in", async () => {
    const s = site({ ownerId: "usr_a" });
    const cap = await resolveRole(resolveViewer(req(), session("usr_stranger")), s);
    expect(cap).toBe(null);
  });

  it("leaves an unclaimed anonymous site read-only for everyone", async () => {
    const s = site({ ownerId: null });
    expect(await resolveRole(resolveViewer(req(), session("usr_anyone")), s)).toBe(null);
  });

  it("grants an explicit collaborator content editing only", async () => {
    const siteId = createId("site");
    await insertSiteWithVersion(
      { id: siteId, tenantId: "init", slug: "sc", title: "t", kind: "single", editToken: "tk", visibility: "public" },
      { id: createId("ver"), siteId, entry: "index.html", fileCount: 1, byteSize: 1, source: "upload" },
    );
    const collab = await upsertUser({ authProvider: "test", providerSubject: "c" });
    await addCollaborator(siteId, collab.id, null);

    const s = site({ id: siteId, ownerId: "usr_a" });
    const cap = await resolveRole(resolveViewer(req(), session(collab.id)), s);
    expect(cap).toBe("editor");
  });

  it("still honours the admin bearer", async () => {
    process.env.PUBLISH_API_TOKEN = "admin-tok";
    const s = site({ ownerId: "usr_a" });
    const viewer = resolveViewer(req({ authorization: "Bearer admin-tok" }));
    expect(await resolveRole(viewer, s)).toBe("platform-admin");
  });
});

describe("authority without OIDC", () => {
  beforeEach(() => { process.env.ARTIFACT_ENFORCE_OWNERSHIP = "on"; });
  afterEach(() => {
    for (const k of ["ARTIFACT_OIDC_ISSUER", "ARTIFACT_OIDC_CLIENT_ID", "ARTIFACT_OIDC_CLIENT_SECRET"]) delete process.env[k];
  });

  it("RBAC still rejects account-tenant tokens without OIDC", async () => {
    const s = site();
    const viewer = resolveViewer(req({ "x-edit-token": "legacy-token" }));
    expect(await resolveRole(viewer, s)).toBe(null);
  });

  it("takes effect once OIDC is configured", async () => {
    process.env.ARTIFACT_OIDC_ISSUER = "https://idp.example/oidc";
    process.env.ARTIFACT_OIDC_CLIENT_ID = "cid";
    process.env.ARTIFACT_OIDC_CLIENT_SECRET = "secret";
    const s = site();
    const viewer = resolveViewer(req({ "x-edit-token": "legacy-token" }));
    expect(await resolveRole(viewer, s)).toBe(null);
  });
});
