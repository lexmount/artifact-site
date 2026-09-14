// Read credential for a private site's sub-resources -- carried in the URL path.
//
// [What this solves]
// Artifacts always run in a `sandbox` iframe WITHOUT allow-same-origin (all three entry points --
// main preview, edit frame, share page -- use the same sandbox; that is an intentional security
// boundary). Such a document is an opaque origin, and the browser classifies every sub-request it
// makes as **cross-site**. Two requests captured in practice tell the whole story:
//
//   (entry)   sec-fetch-site=same-origin  dest=iframe  -> carries the session cookie
//   arch.png  sec-fetch-site=cross-site   dest=image   -> not a single cookie
//
// The entry HTML is fine (that hop is initiated by the parent page); what breaks is every relative
// resource after it. /api/preview has a read gate (lib/share.canReadSite), and no cookie = stranger
// -> private sites always 404. So a private site looks like this: the page skeleton is there, but
// images are gone, styles are gone, scripts do not run. Sharing is hit hardest -- of the four
// visibility tiers only "anyone can view" needs no credential; readers of the other three get a
// broken page.
//
// [Why the credential lives in the path, not a cookie]
// A cookie approach would need `SameSite=None` (the only setting that gets sent in a cross-site
// context), which in turn requires `Secure`, so the whole chain hangs on "did the server judge this
// request to be https" -- one missing header at the reverse proxy, or a different host in local
// dev, and the credential silently falls back to Lax and then silently stops working. Third-party
// cookie deprecation (CHIPS/`Partitioned`) stacks yet another layer of browser policy on top.
// **A credential in the path takes part in none of that**: sub-resources inherit the prefix via
// `<base>`, and the browser is simply fetching a URL.
//
// A query string will not do: relative URL resolution drops it. `<base href="/api/preview/x/">` plus
// `src="a.png"` yields `/api/preview/x/a.png`; a `?key=` never propagates. So the credential must be
// **part of the path**.
//
// [Why `~` is the separator]
// The slug is `randomBytes(9).toString("base64url")`, whose alphabet is only `[A-Za-z0-9_-]` and
// never contains `~`. So `<slug>~<key>` splits back unambiguously and cannot collide with any real
// slug.
//
// [Signing key: why editToken cannot be used]
// We need something that is "consistent across replicas AND unobtainable by the client" to sign
// with. editToken satisfies the first half but **not** the second: it is handed to the caller in
// the site-creation response. And once ownership enforcement is on, editToken's permission is
// deliberately lowered to `none` (see lib/authz) -- using it as the signing key would re-promote an
// already-revoked credential to "can read every byte of this site". Deriving a layer
// (HMAC(editToken, some constant)) does not help: the derivation formula is public.
//
// So the root key is chosen by deployment shape:
//   enforced mode      -> the OIDC client secret. Server-only, consistent across replicas, and
//                         **guaranteed to exist**: config.enforceOwnership silently degrades when
//                         no IdP is configured (see config.ts).
//   non-enforced mode  -> fall back to editToken. There editToken already equals full owner
//                         authority (authz's legacy branch), so signing with it grants nothing new.
import { createHmac } from "node:crypto";
import { config } from "@/lib/config";
import { safeEqual } from "@/lib/crypto";
import type { Site } from "@/lib/types";

/** Credential lifetime. Long enough to read a long document, short enough that a leak expires quickly. */
export const PREVIEW_KEY_TTL_MS = 30 * 60 * 1000;

/** Separator between slug and credential. Absent from the slug's base64url alphabet, so splitting is unambiguous. */
export const PREVIEW_KEY_SEP = "~";

function signingRoot(site: Site): string {
  const serverOnly = config.oidc.clientSecret;
  if (config.enforceOwnership && serverOnly) return serverOnly;
  return site.editToken;
}

function sign(site: Site, expiry: number): string {
  return createHmac("sha256", signingRoot(site))
    .update(`preview-key|${site.id}|${expiry}`)
    .digest("base64url");
}

/** `<expiry timestamp>.<signature>`. The expiry is in plaintext so the server can reject expired keys without a DB lookup. */
export function mintPreviewKey(site: Site, now: number = Date.now()): string {
  const expiry = now + PREVIEW_KEY_TTL_MS;
  return `${expiry}.${sign(site, expiry)}`;
}

/** Was this credential signed for this site, and is it still valid? */
export function verifyPreviewKey(key: string | null, site: Site, now: number = Date.now()): boolean {
  if (!key) return false;
  const at = key.indexOf(".");
  if (at < 0) return false;
  const expiry = Number(key.slice(0, at));
  // Check expiry first: NaN and expired keys both drop out here, saving an HMAC.
  if (!Number.isFinite(expiry) || expiry <= now) return false;
  return safeEqual(key.slice(at + 1), sign(site, expiry));
}

/**
 * Split the first path segment the route received into slug and credential.
 *
 * Only the **first** separator counts: the credential is `<digits>.<base64url>` and contains no `~`,
 * and neither does the slug, so the first one is the only one. When there is nothing to split, the
 * whole segment is the slug (the vast majority of requests today).
 */
export function splitSlugKey(segment: string): { slug: string; key: string | null } {
  const at = segment.indexOf(PREVIEW_KEY_SEP);
  if (at < 0) return { slug: segment, key: null };
  return { slug: segment.slice(0, at), key: segment.slice(at + 1) || null };
}

/**
 * The prefix the artifact's `<base>` should point at.
 *
 * With a key present, sub-resources inherit it automatically -- which is exactly why the whole
 * scheme works: when the browser resolves `src="a.png"` it prepends the entire directory part of
 * `<base>`; the credential is in the path, so it comes along. In a query string it would be dropped.
 */
export function previewBaseHref(slug: string, key: string | null): string {
  const head = key ? `${encodeURIComponent(slug)}${PREVIEW_KEY_SEP}${key}` : encodeURIComponent(slug);
  return `/api/preview/${head}/`;
}
