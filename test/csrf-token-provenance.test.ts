// Every cookie-authenticated write must refuse a request it cannot prove came from our own pages.
// The concrete attacker is not a third-party site (SameSite=Lax already blunts that) but a hosted
// ARTIFACT: it renders in a sandbox without allow-same-origin, so it is an opaque origin whose
// fetches carry `Origin: null` — while, being nested in one of our own pages, it may still ride the
// viewer's ambient cookies. `lib/session.isSameOrigin` is the gate; these routes were missing it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests } from "@/lib/db";
import { createSite } from "@/lib/sites";
import { PATCH, DELETE } from "@/app/api/sites/[slug]/route";
import { POST as ROLLBACK } from "@/app/api/sites/[slug]/rollback/route";
import { POST as FORK } from "@/app/api/sites/[slug]/fork/route";
import { resetUploadSessionsForTests } from "@/lib/upload-session";
const ANON = "anon_owner_under_test";
const dirs: string[] = [];
beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "csrf-"));
    dirs.push(dir);
    process.env.ARTIFACT_DATA_DIR = dir;
    process.env.ARTIFACT_ENFORCE_OWNERSHIP = "on";
    process.env.ARTIFACT_OIDC_ISSUER = "https://idp.example/oidc";
    process.env.ARTIFACT_OIDC_CLIENT_ID = "cid";
    process.env.ARTIFACT_OIDC_CLIENT_SECRET = "secret";
});
afterEach(async () => {
    await resetUploadSessionsForTests();
    await closeDbForTests();
    for (const dir of dirs.splice(0))
        rmSync(dir, { recursive: true, force: true });
    for (const key of ["ARTIFACT_DATA_DIR", "ARTIFACT_ENFORCE_OWNERSHIP", "ARTIFACT_OIDC_ISSUER",
        "ARTIFACT_OIDC_CLIENT_ID", "ARTIFACT_OIDC_CLIENT_SECRET"])
        delete process.env[key];
});
const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
// __Host- cookies are only read over https, so every request here is https.
const creds = { cookie: `__Host-ah_anon=${ANON}`, "x-forwarded-proto": "https" };
const mine = async () => (await createSite({ mode: "paste", html: "<title>t</title><body>x</body>" }, { anonOwnerId: ANON })).site;
/** The four writes, each as (site) → Response, parameterised by the Origin header to send. */
function writes(origin: Record<string, string>) {
    return {
        PATCH: async () => {
            const site = await mine();
            return PATCH(new Request(`https://x/api/sites/${site.slug}`, {
                method: "PATCH", headers: { ...creds, ...origin, "content-type": "application/json" },
                body: JSON.stringify({ title: "renamed" }),
            }), params(site.slug));
        },
        DELETE: async () => {
            const site = await mine();
            return DELETE(new Request(`https://x/api/sites/${site.slug}`, {
                method: "DELETE", headers: { ...creds, ...origin },
            }), params(site.slug));
        },
        ROLLBACK: async () => {
            const site = await mine();
            return ROLLBACK(new Request(`https://x/api/sites/${site.slug}/rollback`, {
                method: "POST", headers: { ...creds, ...origin, "content-type": "application/json" },
                body: JSON.stringify({ versionId: site.currentVersionId }),
            }), params(site.slug));
        },
        FORK: async () => {
            const site = await mine();
            return FORK(new Request(`https://x/api/sites/${site.slug}/fork`, {
                method: "POST", headers: { ...creds, ...origin },
            }), params(site.slug));
        },
    };
}
describe("Invalid token never exempts ambient authority from CSRF", () => {
    it("refuses a hosted artifact's `Origin: null` on every one of them", async () => {
        const w = writes({ origin: "null", "x-edit-token": "invalid-token" });
        for (const [name, run] of Object.entries(w)) {
            expect((await run()).status, `${name} must reject Origin: null`).toBe(401);
        }
    });
    it("refuses a request with no Origin at all", async () => {
        const w = writes({ "x-edit-token": "invalid-token" });
        for (const [name, run] of Object.entries(w)) {
            expect((await run()).status, `${name} must reject a missing Origin`).toBe(401);
        }
    });
    it("refuses a foreign site's Origin", async () => {
        const w = writes({ origin: "https://evil.example", "x-edit-token": "invalid-token" });
        for (const [name, run] of Object.entries(w)) {
            expect((await run()).status, `${name} must reject a foreign Origin`).toBe(401);
        }
    });
});
