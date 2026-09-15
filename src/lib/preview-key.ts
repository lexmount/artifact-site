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
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { previewSecret } from "@/lib/preview-secret";
import type { Site } from "@/lib/types";

/** Credential lifetime. Long enough to read a long document, short enough that a leak expires quickly. */
export const PREVIEW_KEY_TTL_MS = 30 * 60 * 1000;

/** Separator between slug and credential. Absent from the slug's base64url alphabet, so splitting is unambiguous. */
export const PREVIEW_KEY_SEP = "~";

/**
 * Split the first path segment the route received into slug and credential.
 *
 * Only the **first** separator counts: the credential is `v3.<base64url>` and contains no `~`,
 * and neither does the slug, so the first one is the only one. When there is nothing to split, the
 * whole segment is the slug (the vast majority of requests today).
 */
export function splitSlugKey(segment: string): {
  slug: string;
  key: string | null;
} {
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
  const head = key
    ? `${encodeURIComponent(slug)}${PREVIEW_KEY_SEP}${key}`
    : encodeURIComponent(slug);
  return `/api/preview/${head}/`;
}

/** Version-scoped resource credential. Never accepted by write or comment APIs. */
export interface PreviewGrant {
  versionId: string;
  shareId: string | null;
  userId: string | null;
  anonOwnerHash: string | null;
  fingerprint: string;
  management?: "platform-admin" | "tenant-admin";
  /** Old unbound grants are rejected; retained only to decode pre-upgrade payloads. */
  legacy?: boolean;
  sessionId?: string;
  editTokenHash?: string;
  operator?: string;
}
export async function mintScopedPreviewKey(
  site: Site,
  grant: PreviewGrant,
  now = Date.now(),
): Promise<string> {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await encryptionKey(), nonce);
  cipher.setAAD(Buffer.from(`preview-v3|${site.id}|${site.tenantId}`));
  const payload = Buffer.concat([
    cipher.update(JSON.stringify({ ...grant, expiresAt: now + PREVIEW_KEY_TTL_MS })),
    cipher.final(),
  ]);
  return `v3.${Buffer.concat([nonce, cipher.getAuthTag(), payload]).toString("base64url")}`;
}
async function encryptionKey(): Promise<Buffer> {
  return Buffer.from(hkdfSync("sha256", (await previewSecret()).secret, "artifact-hub", "preview-v3", 32));
}
export async function readScopedPreviewKey(
  key: string | null,
  site: Site,
  now = Date.now(),
): Promise<PreviewGrant | null> {
  if (!key) return null;
  const [tag, payload, ...extra] = key.split(".");
  if (tag !== "v3" || !payload || extra.length) return null;
  try {
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", await encryptionKey(), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`preview-v3|${site.id}|${site.tenantId}`));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const data = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
    if (
      typeof data.expiresAt !== "number" ||
      data.expiresAt <= now ||
      typeof data.versionId !== "string" ||
      typeof data.fingerprint !== "string"
    )
      return null;
    return data as PreviewGrant;
  } catch {
    return null;
  }
}
