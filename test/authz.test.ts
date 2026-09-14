// Pins the capability matrix. The bug this guards against is subtle and was shipped in an earlier
// draft: four routes (rename / delete / edit / rollback) all called one identical boolean gate, so
// every tier allowed to edit was silently allowed to DELETE. The "login" tier below is the one that
// matters — it must reach `content` and stop there.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atLeast, resolveCapability, resolveViewer } from "@/lib/authz";
import { addCollaborator, closeDbForTests, createId, insertSiteWithVersion, upsertUser } from "@/lib/db";
import type { Session, Site } from "@/lib/types";

const dirs: string[] = [];

function site(over: Partial<Site> = {}): Site {
  return {
    id: "site_1", slug: "s1", title: "t", kind: "single", currentVersionId: "ver_1",
    createdAt: 1, updatedAt: 1, deletedAt: null, purgedAt: null, takenDownAt: null, takenDownReason: null,
    editToken: "legacy-token", claimToken: "claim-token",
    ownerId: null, anonOwnerId: null, visibility: "public", editPolicy: "owner",
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

describe("atLeast", () => {
  it("orders capabilities so owner implies everything", () => {
    expect(atLeast("owner", "content")).toBe(true);
    expect(atLeast("manage", "content")).toBe(true);
    expect(atLeast("content", "manage")).toBe(false);
    expect(atLeast("none", "content")).toBe(false);
  });
});

describe("legacy mode (ARTIFACT_ENFORCE_OWNERSHIP off)", () => {
  it("keeps today's behaviour: the edit token grants everything", async () => {
    const s = site();
    const withToken = resolveViewer(req({ "x-edit-token": "legacy-token" }));
    expect(await resolveCapability(withToken, s)).toBe("owner");

    const without = resolveViewer(req());
    expect(await resolveCapability(without, s)).toBe("none");
  });

  it("ignores sessions entirely, so a half-upgraded fleet stays self-consistent", async () => {
    const s = site({ ownerId: "usr_a", editPolicy: "login" });
    const viewer = resolveViewer(req(), session("usr_a"));
    expect(await resolveCapability(viewer, s)).toBe("none");
  });
});

describe("enforced mode", () => {
  // Enforcement now requires a configured IdP — without one it deliberately degrades (see the
  // "enforcement requires a configured IdP" block below), so the fixture must supply one.
  beforeEach(() => {
    process.env.ARTIFACT_ENFORCE_OWNERSHIP = "on";
    process.env.ARTIFACT_OIDC_ISSUER = "https://idp.example/oidc";
    process.env.ARTIFACT_OIDC_CLIENT_ID = "cid";
    process.env.ARTIFACT_OIDC_CLIENT_SECRET = "secret";
  });

  it("denies every anonymous write, even with a valid legacy token", async () => {
    const s = site({ editPolicy: "login" });
    const viewer = resolveViewer(req({ "x-edit-token": "legacy-token" }));
    expect(await resolveCapability(viewer, s)).toBe("none");
  });

  it("gives the owner full control", async () => {
    const s = site({ ownerId: "usr_a" });
    expect(await resolveCapability(resolveViewer(req(), session("usr_a")), s)).toBe("owner");
  });

  it("stops a non-owner on an owner-only site", async () => {
    const s = site({ ownerId: "usr_a" });
    expect(await resolveCapability(resolveViewer(req(), session("usr_b")), s)).toBe("none");
  });

  // THE regression guard: the open tier must not reach delete/rename/rollback.
  it("caps edit_policy=login at content — never owner", async () => {
    const s = site({ ownerId: "usr_a", editPolicy: "login" });
    const cap = await resolveCapability(resolveViewer(req(), session("usr_stranger")), s);
    expect(cap).toBe("content");
    expect(atLeast(cap, "content")).toBe(true);
    expect(atLeast(cap, "manage")).toBe(false);
    expect(atLeast(cap, "owner")).toBe(false);   // ← would be a one-request site deletion
  });

  it("leaves an unclaimed anonymous site read-only for everyone", async () => {
    const s = site({ ownerId: null, editPolicy: "owner" });
    expect(await resolveCapability(resolveViewer(req(), session("usr_anyone")), s)).toBe("none");
  });

  it("promotes an explicit collaborator to manage, but not owner", async () => {
    const siteId = createId("site");
    await insertSiteWithVersion(
      { id: siteId, slug: "sc", title: "t", kind: "single", editToken: "tk", visibility: "public" },
      { id: createId("ver"), siteId, entry: "index.html", fileCount: 1, byteSize: 1, source: "upload" },
    );
    const collab = await upsertUser({ authProvider: "test", providerSubject: "c" });
    await addCollaborator(siteId, collab.id, null);

    const s = site({ id: siteId, ownerId: "usr_a" });
    const cap = await resolveCapability(resolveViewer(req(), session(collab.id)), s);
    expect(cap).toBe("manage");
    expect(atLeast(cap, "owner")).toBe(false);
  });

  it("still honours the admin bearer", async () => {
    process.env.PUBLISH_API_TOKEN = "admin-tok";
    const s = site({ ownerId: "usr_a" });
    const viewer = resolveViewer(req({ authorization: "Bearer admin-tok" }));
    expect(await resolveCapability(viewer, s)).toBe("owner");
  });
});

// Enforcement without a configured IdP demands an identity nobody can obtain: every site would
// become permanently uneditable except from the browser that created it, with no recourse on an
// open deployment. It must degrade to the old behaviour, not lock the door.
describe("enforcement requires a configured IdP", () => {
  beforeEach(() => { process.env.ARTIFACT_ENFORCE_OWNERSHIP = "on"; });
  afterEach(() => {
    for (const k of ["ARTIFACT_OIDC_ISSUER", "ARTIFACT_OIDC_CLIENT_ID", "ARTIFACT_OIDC_CLIENT_SECRET"]) delete process.env[k];
  });

  it("is ignored while OIDC is unconfigured — legacy edit tokens still work", async () => {
    const s = site();
    const viewer = resolveViewer(req({ "x-edit-token": "legacy-token" }));
    expect(await resolveCapability(viewer, s)).toBe("owner");
  });

  it("takes effect once OIDC is configured", async () => {
    process.env.ARTIFACT_OIDC_ISSUER = "https://idp.example/oidc";
    process.env.ARTIFACT_OIDC_CLIENT_ID = "cid";
    process.env.ARTIFACT_OIDC_CLIENT_SECRET = "secret";
    const s = site();
    const viewer = resolveViewer(req({ "x-edit-token": "legacy-token" }));
    expect(await resolveCapability(viewer, s)).toBe("none");
  });
});
