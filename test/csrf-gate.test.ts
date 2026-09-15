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
import { POST as OPEN_UPLOAD } from "@/app/api/uploads/route";
import { PUT as PUT_FILE } from "@/app/api/uploads/[versionId]/files/[...relpath]/route";
import { POST as COMMIT } from "@/app/api/uploads/[versionId]/commit/route";
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
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of ["ARTIFACT_DATA_DIR", "ARTIFACT_ENFORCE_OWNERSHIP", "ARTIFACT_OIDC_ISSUER",
    "ARTIFACT_OIDC_CLIENT_ID", "ARTIFACT_OIDC_CLIENT_SECRET"]) delete process.env[key];
});

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
// __Host- cookies are only read over https, so every request here is https.
const creds = { cookie: `__Host-ah_anon=${ANON}`, "x-forwarded-proto": "https" };
const mine = async () =>
  (await createSite({ mode: "paste", html: "<title>t</title><body>x</body>" }, { anonOwnerId: ANON })).site;

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

describe("CSRF gate on cookie-authenticated writes", () => {
  it("refuses a hosted artifact's `Origin: null` on every one of them", async () => {
    const w = writes({ origin: "null" });
    for (const [name, run] of Object.entries(w)) {
      expect((await run()).status, `${name} must reject Origin: null`).toBe(401);
    }
  });

  it("refuses a request with no Origin at all", async () => {
    const w = writes({});
    for (const [name, run] of Object.entries(w)) {
      expect((await run()).status, `${name} must reject a missing Origin`).toBe(401);
    }
  });

  it("refuses a foreign site's Origin", async () => {
    const w = writes({ origin: "https://evil.example" });
    for (const [name, run] of Object.entries(w)) {
      expect((await run()).status, `${name} must reject a foreign Origin`).toBe(401);
    }
  });

  it("still serves our own pages — the product's fetch() sends a matching Origin", async () => {
    const w = writes({ origin: "https://x" });
    expect((await w.PATCH()).status).toBe(200);
    expect((await w.DELETE()).status).toBe(200);
    expect((await w.ROLLBACK()).status).toBe(200);
    expect((await w.FORK()).status).toBe(200);
  });
});

// The gate asks for an Origin only when authorization RODE credentials the browser attached by
// itself. A caller that set a header deliberately — an edit token, or the admin Bearer — is not a
// CSRF vector (an attacker's page cannot set either), and demanding an Origin from it would 401
// every non-browser API client, including the PUBLISH_API_TOKEN flow the published skill documents.
describe("explicit credentials stay exempt — no Origin required", () => {
  // Enforcement OFF: this is the regime where the edit token is still a credential at all (with it
  // on, a bare token is 403 at the authorization layer, long before any CSRF question).
  it("an x-edit-token client needs no Origin", async () => {
    process.env.ARTIFACT_ENFORCE_OWNERSHIP = "off";
    const site = await mine();
    const res = await PATCH(new Request(`https://x/api/sites/${site.slug}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-edit-token": site.editToken },
      body: JSON.stringify({ title: "renamed by api client" }),
    }), params(site.slug));
    expect(res.status).toBe(200);
  });

  it("the admin Bearer needs no Origin", async () => {
    process.env.PUBLISH_API_TOKEN = "s3cret";
    try {
      const site = await mine();
      const res = await DELETE(new Request(`https://x/api/sites/${site.slug}`, {
        method: "DELETE", headers: { authorization: "Bearer s3cret" },
      }), params(site.slug));
      expect(res.status).toBe(200);
    } finally {
      delete process.env.PUBLISH_API_TOKEN;
    }
  });

  it("a scripted fork still needs source permission", async () => {
    const site = await mine();
    const res = await FORK(new Request(`https://x/api/sites/${site.slug}/fork`, { method: "POST" }), params(site.slug));
    expect(res.status).toBe(404);
  });
});

// The published skill (served at /for-agents.md) tells agents which calls need an Origin header.
// It was wrong before this change — it claimed PATCH/DELETE/rollback rejected a missing Origin
// while they in fact accepted anything. Pin the doc to the code so the two cannot drift again.
// The chunked path is the same write as POST …/versions, split into three requests. All three
// ride the same cookies, so all three answer the same way when they target an existing site;
// a session for a NEW site is creation and stays ungated end to end.
describe("CSRF gate on the chunked upload of a new version", () => {
  const openFor = (slug: string | undefined, origin: Record<string, string>) =>
    OPEN_UPLOAD(new Request("https://x/api/uploads", {
      method: "POST", headers: { ...creds, ...origin, "content-type": "application/json" },
      body: JSON.stringify(slug ? { slug } : { title: "fresh" }),
    }));
  const bytes = new TextEncoder().encode("<!doctype html><title>v2</title>");
  const putFor = (versionId: string, origin: Record<string, string>) =>
    PUT_FILE(new Request(`https://x/api/uploads/${versionId}/files/index.html`, {
      method: "PUT", headers: { ...creds, ...origin, "content-type": "application/octet-stream", "content-length": String(bytes.byteLength) }, body: bytes,
    }), { params: Promise.resolve({ versionId, relpath: ["index.html"] }) });
  const commitFor = (versionId: string, origin: Record<string, string>) =>
    COMMIT(new Request(`https://x/api/uploads/${versionId}/commit`, {
      method: "POST", headers: { ...creds, ...origin, "content-type": "application/json" }, body: "{}",
    }), { params: Promise.resolve({ versionId }) });

  it("opening a session on an existing site refuses Origin: null, a missing Origin and a foreign Origin", async () => {
    for (const origin of [{ origin: "null" }, {}, { origin: "https://evil.example" }] as Record<string, string>[]) {
      const site = await mine();
      expect((await openFor(site.slug, origin)).status, JSON.stringify(origin)).toBe(401);
    }
  });

  it("the PUT and commit steps repeat the check — an honest opener does not vouch for a forged follow-up", async () => {
    const site = await mine();
    const opened = await openFor(site.slug, { origin: "https://x" });
    expect(opened.status).toBe(201);
    const { versionId } = (await opened.json()) as { versionId: string };
    expect((await putFor(versionId, { origin: "null" })).status).toBe(401);
    expect((await putFor(versionId, { origin: "https://x" })).status).toBe(200);
    expect((await commitFor(versionId, {})).status).toBe(401);
    // A refused commit must not have discarded the session: the honest client can still finish.
    expect((await commitFor(versionId, { origin: "https://x" })).status).toBe(201);
  });

  it("new-site cookie uploads require an Origin at every step", async () => {
    expect((await openFor(undefined, {})).status).toBe(401);
    const opened = await openFor(undefined, {origin:"https://x"});
    expect(opened.status).toBe(201);
    const {versionId} = await opened.json();
    expect((await putFor(versionId, {})).status).toBe(401);
    expect((await putFor(versionId, {origin:"https://x"})).status).toBe(200);
    expect((await commitFor(versionId, {})).status).toBe(401);
    expect((await commitFor(versionId, {origin:"https://x"})).status).toBe(201);
  });

  it("an x-edit-token client needs no Origin on the chunked path either", async () => {
    process.env.ARTIFACT_ENFORCE_OWNERSHIP = "off";
    const site = await mine();
    const token = { "x-edit-token": site.editToken, "content-type": "application/json" };
    const opened = await OPEN_UPLOAD(new Request("https://x/api/uploads", { method: "POST", headers: token, body: JSON.stringify({ slug: site.slug }) }));
    expect(opened.status).toBe(201);
  });
});

describe("the published skill matches the gate it documents", () => {
  const gated = [
    "src/app/api/sites/[slug]/route.ts",
    "src/app/api/sites/[slug]/rollback/route.ts",
    "src/app/api/sites/[slug]/fork/route.ts",
    "src/app/api/sites/[slug]/edit/route.ts",
    "src/app/api/uploads/route.ts",
    "src/lib/upload-csrf.ts",
  ];

  it("every write route the doc lists really does enforce the gate (csrfSafe = same-origin OR a deliberate Bearer)", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of gated) {
      // csrfSafe wraps isSameOrigin; the ambient-cookie rejections above prove the wrap didn't
      // loosen anything — a publish-token Bearer is the one deliberate credential it admits.
      expect(readFileSync(file, "utf8"), `${file} must enforce the gate`).toContain("assertMutationOrigin(request");
    }
  });

  it("creation applies the same origin gate to cookie requests", async () => {
    const { readFileSync } = await import("node:fs");
    const create = readFileSync("src/app/api/sites/route.ts", "utf8");
    expect(create).toContain("assertMutationOrigin(request)");
    expect(create).not.toContain("csrfSafe");
    expect(readFileSync("src/content/publish-skill.md", "utf8")).toContain("Cookie-based mutating requests must carry `Origin`");
  });
});
