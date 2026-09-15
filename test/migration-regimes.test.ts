import { setSiteOwnerIfUnowned } from "./fixtures/legacy-identity";
// What each generation of row does when ownership enforcement is switched on. The dangerous case
// is a deployment that jumps straight to enforcement: rows created before the identity migration
// carry no signal at all, and without the grandfather clause they freeze permanently — claiming
// needs a receipt they never got, adoption matches an anon id they never had, and an open
// deployment has no admin token to appeal to.
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, createId, getSiteBySlug, insertSiteWithVersion, upsertUser } from "@/lib/db";
import { atLeast, resolveCapability, resolveViewer } from "@/lib/authz";
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

describe("skipping stage 2", () => {
  it("PRE-identity rows have no ownership signal at all", async () => {
    const s = await mk("pre", {});
    expect(s.anonOwnerId).toBeNull();
    expect(s.claimToken).toBe("");   // no claim receipt was ever minted

    const creator = resolveViewer(req({ "x-edit-token": s.editToken, cookie: "__Host-ah_anon=anon_A" }));
    expect(await resolveCapability(creator, s)).toBe("owner");   // stage 1
    enforce();
    // Without the grandfather clause this returned "none" — frozen for everyone, with no claim
    // receipt to redeem, no anon id to adopt, and no admin token on an open deployment.
    expect(await resolveCapability(creator, s)).toBe("owner");
  });

  it("stage-1 rows keep working for the creating browser without any login", async () => {
    const s = await mk("during", { claimToken: "CT", anonOwnerId: "anon_A" });
    enforce();
    const sameBrowser = resolveViewer(req({ cookie: "__Host-ah_anon=anon_A" }));
    const other = resolveViewer(req({ "x-edit-token": s.editToken, cookie: "__Host-ah_anon=anon_B" }));
    expect(await resolveCapability(sameBrowser, s)).toBe("owner");
    expect(await resolveCapability(other, s)).toBe("owner");
  });
});

describe("grandfather clause", () => {
  it("keeps pre-identity rows editable by their token holder instead of freezing them", async () => {
    const s = await mk("legacy", {});
    enforce();
    const holder = resolveViewer(req({ "x-edit-token": s.editToken }));
    expect(await resolveCapability(holder, s)).toBe("owner");

    const nobody = resolveViewer(req({ "x-edit-token": "wrong" }));
    expect(await resolveCapability(nobody, s)).toBe("none");
  });

  it("also supports current anonymous reports, independent of historical claim receipts", async () => {
    // The clause keys on "no signal at all". A site that has an anon owner is a modern row, so a
    // stranger holding its edit token stays refused.
    const s = await mk("modern", { claimToken: "CT", anonOwnerId: "anon_A" });
    enforce();
    const holder = resolveViewer(req({ "x-edit-token": s.editToken }));
    expect(await resolveCapability(holder, s)).toBe("owner");
  });
});

// The stage-1-to-stage-3 path: nobody claimed anything in advance, so ownership has to settle at
// the moment someone is blocked and signs in. Adoption must not turn a shared site into one
// person's private property.
describe("claiming retires legacy edit tokens", () => {
  it("requires a new share or membership after claiming", async () => {
    const s = await mk("shared-legacy", {});
    enforce();
    const holder = resolveViewer(req({ "x-edit-token": s.editToken }));

    // Before anyone signs in: the token is the only signal, so it carries everything.
    expect(await resolveCapability(holder, s)).toBe("owner");

    // A colleague signs in and adopts it. The creator — and everyone else the editable link was
    // sent to — keeps editing, but renaming/deleting/sharing now settle with the owner.
    const owner = await upsertUser({ authProvider: "t", providerSubject: "adopter" });
    expect(await setSiteOwnerIfUnowned(s.id, owner.id)).toBe(true);
    const adopted = (await getSiteBySlug("shared-legacy"))!;

    const cap = await resolveCapability(holder, adopted);
    expect(cap).toBe("none");
    expect(atLeast(cap, "manage")).toBe(false);
  });

  it("supports anonymous management without granting account ownership", async () => {
    const s = await mk("modern-2", { claimToken: "CT", anonOwnerId: "anon_A" });
    enforce();
    expect(await resolveCapability(resolveViewer(req({ "x-edit-token": s.editToken })), s)).toBe("owner");
  });
});
