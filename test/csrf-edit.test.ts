import { setSiteOwnerIfUnowned } from "./fixtures/legacy-identity";
// CSRF on the edit route is scoped to AMBIENT credentials — a cookie the browser attaches on its
// own. A signed-in session must therefore be same-origin. A per-site token or the admin Bearer is
// set deliberately by the caller (an attacker's page cannot add either header), so it is CSRF-immune
// and exempt: requiring same-origin there would 401 every non-browser API client, which is exactly
// the regression this pins down. Authorization runs first, so a request with no credential at all
// is already refused (403) before the CSRF check is ever reached.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, upsertUser } from "@/lib/db";
import { mintSession } from "@/lib/session";
import { createSite } from "@/lib/sites";
import { POST as editPOST } from "@/app/api/sites/[slug]/edit/route";

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
const dirs: string[] = [];
beforeEach(() => { const d = mkdtempSync(join(tmpdir(), "ah-csrf-")); dirs.push(d); process.env.ARTIFACT_DATA_DIR = d; });
afterEach(async () => {
  await closeDbForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const k of [
    "ARTIFACT_DATA_DIR", "ARTIFACT_ENFORCE_OWNERSHIP",
    "ARTIFACT_OIDC_ISSUER", "ARTIFACT_OIDC_CLIENT_ID", "ARTIFACT_OIDC_CLIENT_SECRET", "PUBLISH_API_TOKEN",
  ]) delete process.env[k];
});

function enforce() {
  process.env.ARTIFACT_ENFORCE_OWNERSHIP = "on";
  process.env.ARTIFACT_OIDC_ISSUER = "https://idp/oidc";
  process.env.ARTIFACT_OIDC_CLIENT_ID = "c";
  process.env.ARTIFACT_OIDC_CLIENT_SECRET = "s";
}

function editReq(slug: string, headers: Record<string, string>): Request {
  return new Request(`https://x/api/sites/${slug}/edit`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-proto": "https", ...headers },
    body: JSON.stringify({ content: "<body>edited</body>" }),
  });
}

describe("edit CSRF — ambient cookies must be same-origin; tokens are exempt", () => {
  // The half that must STAY protected: a session cookie is ambient, so an edit carrying one but no
  // (or a foreign) Origin has the shape of a cross-site forgery and is refused.
  it("rejects a signed-in cookie edit with no Origin, accepts it with a matching Origin", async () => {
    enforce();
    const user = await upsertUser({ authProvider: "t", providerSubject: "owner" });
    const { site } = await createSite({ mode: "paste", html: "<title>C</title><body>one</body>" });
    await setSiteOwnerIfUnowned(site.id, user.id); // now the session resolves to owner capability
    const { cookie } = await mintSession(
      new Request("https://x/", { headers: { "x-forwarded-proto": "https" } }), user.id,
    );
    const cookieHeader = cookie.split(";")[0];

    const noOrigin = await editPOST(editReq(site.slug, { cookie: cookieHeader }), params(site.slug));
    expect(noOrigin.status).toBe(401); // ambient credential + no Origin → cross-site shape → AuthError

    const sameOrigin = await editPOST(
      editReq(site.slug, { cookie: cookieHeader, origin: "https://x" }), params(site.slug),
    );
    expect(sameOrigin.status).toBe(200);
  });

  // The half that regressed and is now fixed: a per-site token is non-ambient, so it needs no Origin.
  it("exempts a per-site token edit from the Origin requirement", async () => {
    const { site } = await createSite({ mode: "paste", html: "<title>T</title><body>one</body>" });
    const res = await editPOST(editReq(site.slug, { "x-edit-token": site.editToken }), params(site.slug));
    expect(res.status).toBe(200);
  });
});
