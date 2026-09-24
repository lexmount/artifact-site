import { resolveRole } from "./fixtures/authorization-role";
import { setSiteOwnerIfUnowned } from "./fixtures/legacy-identity";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, createId, getSiteBySlug, insertSiteWithVersion, upsertUser } from "@/lib/db";
import { resolveViewer } from "@/lib/authz";
import type { Site } from "@/lib/types";

const dirs: string[] = [];
beforeEach(() => { const d = mkdtempSync(join(tmpdir(), "skip2-")); dirs.push(d); process.env.ARTIFACT_DATA_DIR = d; });
afterEach(async () => {
  await closeDbForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const k of ["ARTIFACT_DATA_DIR","ARTIFACT_ENFORCE_OWNERSHIP","ARTIFACT_OIDC_ISSUER","ARTIFACT_OIDC_CLIENT_ID","ARTIFACT_OIDC_CLIENT_SECRET"]) delete process.env[k];
});

async function mk(slug: string, extra: Record<string, unknown> = {}): Promise<Site> {
  const id = createId("site");
  await insertSiteWithVersion(
    { id, slug, title: slug, kind: "single", editToken: `TOK-${slug}`, ...extra, visibility: "public" },
    { id: createId("ver"), siteId: id, entry: "index.html", fileCount: 1, byteSize: 1, source: "upload" });
  return (await getSiteBySlug(slug))!;
}
const req = (h: Record<string,string> = {}) => new Request("https://x/api", { headers: h });
function enforce() {
  process.env.ARTIFACT_ENFORCE_OWNERSHIP = "on";
  process.env.ARTIFACT_OIDC_ISSUER = "https://idp/oidc";
  process.env.ARTIFACT_OIDC_CLIENT_ID = "c";
  process.env.ARTIFACT_OIDC_CLIENT_SECRET = "s";
}

describe("anonymous creator credentials", () => {
  it("anonymous token-only sites retain management access", async () => {
    const s = await mk("pre", {});
    expect(s.anonOwnerId).toBeNull();
    expect(s).not.toHaveProperty("claimToken");

    const creator = resolveViewer(req({ "x-edit-token": s.editToken, cookie: "__Host-ah_anon=anon_A" }));
    expect(await resolveRole(creator, s)).toBe("owner");
    enforce();
    expect(await resolveRole(creator, s)).toBe("owner");
  });

  it("the creator cookie and management token each authorize an anonymous site", async () => {
    const s = await mk("during", { anonOwnerId: "anon_A" });
    enforce();
    const sameBrowser = resolveViewer(req({ cookie: "__Host-ah_anon=anon_A" }));
    const other = resolveViewer(req({ "x-edit-token": s.editToken, cookie: "__Host-ah_anon=anon_B" }));
    expect(await resolveRole(sameBrowser, s)).toBe("owner");
    expect(await resolveRole(other, s)).toBe("owner");
  });
});

describe("anonymous management tokens", () => {
  it("requires a valid token for token-only anonymous sites", async () => {
    const s = await mk("legacy", {});
    enforce();
    const holder = resolveViewer(req({ "x-edit-token": s.editToken }));
    expect(await resolveRole(holder, s)).toBe("owner");

    const nobody = resolveViewer(req({ "x-edit-token": "wrong" }));
    expect(await resolveRole(nobody, s)).toBe(null);
  });

  it("also supports current anonymous reports independently of the creator cookie", async () => {
    const s = await mk("modern", { anonOwnerId: "anon_A" });
    enforce();
    const holder = resolveViewer(req({ "x-edit-token": s.editToken }));
    expect(await resolveRole(holder, s)).toBe("owner");
  });
});

describe("claiming retires legacy edit tokens", () => {
  it("requires a new share or membership after claiming", async () => {
    const s = await mk("shared-legacy", {});
    enforce();
    const holder = resolveViewer(req({ "x-edit-token": s.editToken }));

    expect(await resolveRole(holder, s)).toBe("owner");

    const owner = await upsertUser({ authProvider: "t", providerSubject: "adopter" });
    expect(await setSiteOwnerIfUnowned(s.id, owner.id)).toBe(true);
    const adopted = (await getSiteBySlug("shared-legacy"))!;

    const cap = await resolveRole(holder, adopted);
    expect(cap).toBe(null);
  });

  it("supports anonymous management without granting account ownership", async () => {
    const s = await mk("modern-2", { anonOwnerId: "anon_A" });
    enforce();
    expect(await resolveRole(resolveViewer(req({ "x-edit-token": s.editToken })), s)).toBe("owner");
  });
});
