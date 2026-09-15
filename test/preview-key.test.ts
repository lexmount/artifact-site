import { createHash } from "node:crypto";
// The read credential for a private site's sub-resources (carried in the URL path).
//
// The symptom to prevent: the artifact runs in an opaque-origin sandbox iframe, so the browser
// classifies its sub-requests as cross-site and sends no cookies at all — someone who just viewed
// the full page is treated as a stranger on every image/stylesheet/script. The credential is
// therefore written into the `<base>` path prefix so relative resources inherit it automatically.
//
// These tests watch three things: the credential really unlocks sub-resources, it unlocks ONLY the
// site that issued it, and it expires; plus two design constraints: revocation must actually take
// effect (a credential may not extend its own life), and in enforced mode the signing secret must
// not be something the client can obtain.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { closeDbForTests, updateSiteSharing } from "@/lib/db";
import { createSite } from "@/lib/sites";
import {
  PREVIEW_KEY_SEP, PREVIEW_KEY_TTL_MS, mintScopedPreviewKey, readScopedPreviewKey, previewBaseHref, splitSlugKey,
} from "@/lib/preview-key";
import { GET as previewGET } from "@/app/api/preview/[slug]/[[...path]]/route";
import type { Site } from "@/lib/types";

const mintPreviewKey = (site: Site, now = Date.now()) => mintScopedPreviewKey(site, {versionId:site.currentVersionId,shareId:null,userId:null,anonOwnerHash:null,fingerprint:"",editTokenHash:createHash("sha256").update(site.editToken).digest("hex")},now);
const verifyPreviewKey = async (key: string, site: Site) => (await readScopedPreviewKey(key,site)) !== null;

const ORIGIN = "https://x";
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ah-pvkey-"));
  process.env.ARTIFACT_DATA_DIR = dir;
  process.env.ARTIFACT_PUBLIC_URL = ORIGIN;
  // A new site's default visibility follows the deployment (config.defaultVisibility), and the URL
  // above would push it to private. These tests control each site's visibility themselves, so pin
  // the birth state to public; the cases that need private set it explicitly.
  process.env.ARTIFACT_DEFAULT_VISIBILITY = "public";
});
afterEach(async () => {
  await closeDbForTests();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ARTIFACT_DATA_DIR;
  delete process.env.ARTIFACT_PUBLIC_URL;
  delete process.env.ARTIFACT_DEFAULT_VISIBILITY;
});

const made = async (): Promise<Site> =>
  (await createSite({
    mode: "folder",
    files: [
      { relpath: "index.html", bytes: new TextEncoder().encode('<html><head><title>t</title></head><body><img src="a.png"></body></html>') },
      { relpath: "a.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
    ],
  }, {})).site;

/** The first segment the route receives is `<slug>` or `<slug>~<key>`, so the tests feed it in that shape. */
const get = (segment: string, path: string[], editToken?: string) =>
  previewGET(
    new Request(`${ORIGIN}/api/preview/${segment}/${path.join("/")}`, {
      headers: editToken ? { "x-edit-token": editToken } : {},
    }),
    { params: Promise.resolve({ slug: segment, path }) },
  );

const keyed = (slug: string, key: string) => `${slug}${PREVIEW_KEY_SEP}${key}`;

describe("a private site's sub-resources: the opaque frame gets in via the credential in the path", () => {
  it("a sub-request without the credential is 404 — that is the moment the image breaks", async () => {
    const site = await made();
    await updateSiteSharing(site.id, "private", "owner");
    expect((await get(site.slug, ["a.png"])).status).toBe(404);
  });

  it("carrying a credential issued by this site in the URL fetches it", async () => {
    const site = await made();
    await updateSiteSharing(site.id, "private", "owner");
    expect((await get(keyed(site.slug, await mintPreviewKey(site)), ["a.png"])).status).toBe(200);
  });

  it("[KEY] a credential issued by another site does not open this one", async () => {
    const mine = await made();
    const other = await made();
    await updateSiteSharing(mine.id, "private", "owner");
    // The signature binds the siteId and the secret is derived per site — both layers mismatch.
    expect((await get(keyed(mine.slug, await mintPreviewKey(other)), ["a.png"])).status).toBe(404);
  });

  it("an expired credential does not count", async () => {
    const site = await made();
    await updateSiteSharing(site.id, "private", "owner");
    const stale = await mintPreviewKey(site, Date.now() - PREVIEW_KEY_TTL_MS - 1000);
    expect((await get(keyed(site.slug, stale), ["a.png"])).status).toBe(404);
  });

  it("changing a single byte is rejected — the expiry is covered by the signature and cannot be pushed", async () => {
    const site = await made();
    const [exp, sig] = (await mintPreviewKey(site)).split(".");
    expect(await verifyPreviewKey(`${Number(exp) + 86_400_000}.${sig}`, site)).toBe(false);
  });

  it("a garbage credential segment neither derails the request nor gets treated as a new site", async () => {
    const site = await made();
    await updateSiteSharing(site.id, "private", "owner");
    for (const junk of ["", "not-a-key", "abc.def", "999999999999.x"]) {
      expect((await get(keyed(site.slug, junk), ["a.png"])).status).toBe(404);
    }
  });
});

describe("the credential is written into the artifact's <base>", () => {
  it("a private site's entry HTML carries the credential in <base> — that is how sub-resources inherit it", async () => {
    const site = await made();
    await updateSiteSharing(site.id, "private", "owner");
    const res = await get(site.slug, [], site.editToken); // the real gate (this deployment has no ownership enforcement)
    const html = await res.text();

    const base = html.match(/<base href="([^"]*)">/)?.[1] ?? "";
    expect(base.startsWith(`/api/preview/${site.slug}${PREVIEW_KEY_SEP}`)).toBe(true);
    expect(base.endsWith("/")).toBe(true); // without the trailing slash, relative paths resolve one level up

    // Dig the credential out of <base>; it must actually work — this pins "what was injected" and
    // "what verifies" together.
    const minted = base.slice(`/api/preview/${site.slug}${PREVIEW_KEY_SEP}`.length, -1);
    expect(await verifyPreviewKey(minted, site)).toBe(true);
  });

  it("a public current-version site keeps stable cacheable asset URLs", async () => {
    const site = await made();
    const html = await (await get(site.slug, [])).text();
    expect(html).toContain(`<base href="/api/preview/${site.slug}/">`);
  });
});

describe("revocation must actually take effect: a credential cannot extend its own life", () => {
  // If entering with a credential also handed out a fresh one, someone whose share was revoked
  // could keep the credential rolling forever just by keeping the page open and fetching resources,
  // and revocation would be a dead letter. So minting happens only when the real gate passes;
  // entry by credential keeps the one already in hand.
  it("fetching the entry by credential leaves the original credential in <base>, not a fresh one", async () => {
    const site = await made();
    await updateSiteSharing(site.id, "private", "owner");
    const key = await mintPreviewKey(site);

    const html = await (await get(keyed(site.slug, key), [])).text();
    expect(html).toContain(`<base href="/api/preview/${site.slug}${PREVIEW_KEY_SEP}${key}/">`);
  });

  it("a fresh credential is minted only when entering through the real gate", async () => {
    const site = await made();
    await updateSiteSharing(site.id, "private", "owner");
    const old = await mintPreviewKey(site, Date.now() - 60_000); // minted earlier, so the signature differs

    const html = await (await get(site.slug, [], site.editToken)).text();
    expect(html).not.toContain(old);
  });
});

describe("splitting slug from credential", () => {
  it("without a separator the whole segment is the slug — the shape of nearly every request today", () => {
    expect(splitSlugKey("abc123")).toEqual({ slug: "abc123", key: null });
  });

  it("only the first separator counts", () => {
    expect(splitSlugKey("abc~123.sig~tail")).toEqual({ slug: "abc", key: "123.sig~tail" });
  });

  it("the slug alphabet does not contain the separator, so the split is always clean", async () => {
    // slug = randomBytes(9).toString("base64url"), which is only [A-Za-z0-9_-]
    for (let i = 0; i < 30; i++) {
      expect((await made()).slug).not.toContain(PREVIEW_KEY_SEP);
    }
  });

  it("previewBaseHref ends with a slash in both shapes", () => {
    expect(previewBaseHref("s", null)).toBe("/api/preview/s/");
    expect(previewBaseHref("s", "1.k")).toBe(`/api/preview/s${PREVIEW_KEY_SEP}1.k/`);
  });
});

describe("signing secret: in enforced mode it must not be something the client can obtain", () => {
  const OIDC = ["ARTIFACT_ENFORCE_OWNERSHIP", "ARTIFACT_OIDC_ISSUER", "ARTIFACT_OIDC_CLIENT_ID", "ARTIFACT_OIDC_CLIENT_SECRET"];
  const enforce = () => {
    process.env.ARTIFACT_ENFORCE_OWNERSHIP = "on";
    process.env.ARTIFACT_OIDC_ISSUER = "https://idp.example/oidc";
    process.env.ARTIFACT_OIDC_CLIENT_ID = "cid";
    process.env.ARTIFACT_OIDC_CLIENT_SECRET = "server-only-secret";
  };
  afterEach(() => { for (const k of OIDC) delete process.env[k]; });

  const forgeWith = (secret: string, site: Site) => {
    const expiry = Date.now() + 60_000;
    return `${expiry}.${createHmac("sha256", secret).update(`preview-key|${site.id}|${expiry}`).digest("base64url")}`;
  };

  it("[KEY] someone holding the editToken cannot forge a valid credential", async () => {
    const site = await made();
    enforce();
    // The editToken is handed to the caller in the create-site response, and in enforced mode its
    // authority has been reduced to none. A credential signed with it must be rejected — otherwise
    // a retired token is promoted back to "can read every byte of the site".
    expect(await verifyPreviewKey(forgeWith(site.editToken, site), site)).toBe(false);
  });

  it("a credential the server minted itself is still accepted", async () => {
    const site = await made();
    enforce();
    expect(await verifyPreviewKey(await mintPreviewKey(site), site)).toBe(true);
  });

  it("a non-enforced deployment also refuses client-forged credentials", async () => {
    const site = await made();
    expect(await verifyPreviewKey(forgeWith(site.editToken, site), site)).toBe(false);
  });
});
