// Shapes + input validation shared by the share-link admin routes. Not a `route.ts`, so Next never
// treats it as an endpoint (same arrangement as app/api/_util.ts).
//
// Recoverable URLs are added only by the authorized management listing.
import type { NextResponse } from "next/server";
import { getShare, getUser, listShareGrants } from "@/lib/db";
import { isLive } from "@/lib/share";
import { requirePermission } from "@/lib/authz";
import { getSiteView } from "@/lib/sites";
import { EXPIRY_DAYS, SHARE_POLICIES, type Actor, type Share, type SharePolicy, type ShareRow, type Site, type User } from "@/lib/types";
import { json } from "../../../_util";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Owner-facing note, never shown to readers — a display string, not a document. */
const MAX_LABEL_LENGTH = 80;
/** Wide enough for a passphrase, narrow enough that nobody stores a novel in the column. */
const MIN_PASSCODE_LENGTH = 4;
const MAX_PASSCODE_LENGTH = 64;
/** The longest address RFC 5321 permits. */
const MAX_EMAIL_LENGTH = 254;

/** A rejected body. Carries `statusCode` so `errorResponse` maps it to 400 with the message intact. */
export class ShareInputError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "ShareInputError";
  }
}

export function parsePolicy(raw: unknown, fallback: SharePolicy): SharePolicy {
  if (raw === "email") raw = "people"; // Compatibility with published CLI/MCP versions.
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "string" || !SHARE_POLICIES.includes(raw as SharePolicy)) {
    throw new ShareInputError(`policy must be one of ${SHARE_POLICIES.join(" / ")}`);
  }
  return raw as SharePolicy;
}

/**
 * `expiresInDays` → an absolute timestamp.
 *
 * Three-valued on purpose, and the distinction matters on PATCH: `undefined` (the key was absent)
 * means "leave the expiry alone", while an explicit `null` means "make it never expire". Collapsing them
 * would make every unrelated PATCH — renaming a label, say — silently un-expire the link.
 */
export function parseExpiry(raw: unknown, now: number = Date.now()): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "number" || !EXPIRY_DAYS.includes(raw)) {
    throw new ShareInputError(`expiresInDays must be one of ${EXPIRY_DAYS.join(" / ")}; omit it for a link that never expires`);
  }
  return now + raw * DAY_MS;
}

export function parseLabel(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new ShareInputError("label must be a string");
  const label = raw.trim();
  if (!label) return null;
  if (label.length > MAX_LABEL_LENGTH) throw new ShareInputError(`The label is too long (at most ${MAX_LABEL_LENGTH} characters)`);
  return label;
}

/**
 * A caller-chosen passcode, or undefined when they did not supply one.
 *
 * Note for whoever writes the UI copy: entry is case-insensitive (hashPasscode upper-cases before
 * hashing), so telling a reader "mind the case" would be a lie.
 */
export function parsePasscode(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new ShareInputError("passcode must be a string");
  const code = raw.trim();
  if (!code) return undefined;
  if (code.length < MIN_PASSCODE_LENGTH || code.length > MAX_PASSCODE_LENGTH) {
    throw new ShareInputError(`The passcode must be ${MIN_PASSCODE_LENGTH}–${MAX_PASSCODE_LENGTH} characters long`);
  }
  if (/\s/.test(code)) throw new ShareInputError("The passcode cannot contain whitespace");
  return code;
}

/**
 * Canonicalize an invited address. Lower-cased because that is what the storage layer compares
 * (`lower(email) = lower(?)` on both backends) and because the same address typed two ways must
 * not become two rows on one share.
 */
export function parseEmail(raw: unknown): string {
  if (typeof raw !== "string") throw new ShareInputError("email is required");
  const email = raw.trim().toLowerCase();
  if (!email) throw new ShareInputError("email is required");
  if (email.length > MAX_EMAIL_LENGTH) throw new ShareInputError("The email is too long");
  // Shape only, not deliverability — the real check is whether it ever matches a VERIFIED address.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ShareInputError("The email format is invalid");
  return email;
}

/** One entry on a `people` share, as the owner's panel wants to draw it. */
export interface GrantView {
  userId: string | null;
  email: string | null;
  displayName: string | null;
  grantedAt: number;
  /** True for an address with no account behind it yet — it starts working the moment they sign in. */
  pending: boolean;
}

/**
 * A share's guest list. `cache` lets a caller listing several shares of one site look each account
 * up once instead of once per grant.
 *
 * An account's e-mail is shown only while VERIFIED: an unverified address is attacker-controllable,
 * so rendering one next to a name would let an account claim a colleague's identity in the very
 * list the owner uses to decide who is on it.
 */
export async function loadGrants(shareId: string, cache?: Map<string, User | null>): Promise<GrantView[]> {
  const users = cache ?? new Map<string, User | null>();
  const out: GrantView[] = [];
  for (const grant of await listShareGrants(shareId)) {
    if (!grant.userId) {
      out.push({ userId: null, email: grant.email, displayName: null, grantedAt: grant.grantedAt, pending: true });
      continue;
    }
    if (!users.has(grant.userId)) users.set(grant.userId, await getUser(grant.userId));
    const user = users.get(grant.userId) ?? null;
    out.push({
      userId: grant.userId,
      email: user?.emailVerified ? user.email : null,
      displayName: grant.displayName ?? user?.displayName ?? null,
      grantedAt: grant.grantedAt,
      pending: false,
    });
  }
  return out;
}

/** Why a link is not working, as three states rather than one boolean — see `summarize`. */
export type ShareStatus = "live" | "revoked" | "expired";

export interface ShareSummary {
  revision: number;
  source?: "publish" | "manual" | null;
  mode: Share["mode"];
  versionId: string | null;
  id: string;
  policy: SharePolicy;
  label: string | null;
  hasPasscode: boolean;
  allowAi: boolean;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  live: boolean;
  status: ShareStatus;
  grants: GrantView[];
  grantCount: number;
}

/**
 * The owner-facing projection of a share. Contains no token and no passcode; URL recovery is explicit in the list route.
 *
 * `status` is three-valued where `live` is two, because the owner is the person who has to answer
 * "why can't I open this any more?". "I revoked it" and "it passed its expiry" have different answers and
 * different remedies; a bare `live: false` throws that away. (Readers still get one undifferentiated
 * "This link is no longer valid" — see resolveShareAccess's `notFound`, which must not confirm a token ever existed.)
 */
export function summarize(share: Share, grants: GrantView[], now: number = Date.now()): ShareSummary {
  const live = isLive(share, now);
  return {
    revision: share.revision ?? 0,
    mode: share.mode,
    versionId: share.versionId,
    id: share.id,
    policy: share.policy,
    label: share.label,
    source: share.source ?? null,
    hasPasscode: share.hasPasscode,
    allowAi: share.allowAi,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    revokedAt: share.revokedAt,
    live,
    status: share.revokedAt != null ? "revoked" : live ? "live" : "expired",
    grants,
    grantCount: grants.length,
  };
}

/** The reader-facing address of a share link. One definition, so the two places that mint it agree. */
export function shareUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/v/${token}`;
}

/** Either a refusal to hand straight back, or an owned share. Tagged rather than inferred, so a
 *  caller cannot forget the first case — `resolved.share` does not exist until `ok` is checked. */
export type OwnedShare =
  | { ok: false; response: NextResponse }
  | { ok: true; site: Site; share: ShareRow; actor: Actor };

/**
 * Resolve `<slug>/shares/<shareId>` to a share that really belongs to that site, having first proved
 * the caller owns the site.
 *
 * The `siteId` re-check is the load-bearing line, and the reason this lives in one place rather than
 * being retyped per route. Share ids are opaque but they are NOT secret — the owner's own listing
 * hands them out — so without it, anyone who owns any site at all could name someone else's share id
 * under their own slug and revoke it, re-point it at `public`, or read its guest list. Answering 404
 * rather than 403 keeps the route from doubling as an oracle for which ids exist.
 */
export async function resolveOwnedShare(request: Request, slug: string, shareId: string): Promise<OwnedShare> {
  const view = await getSiteView(slug);
  if (!view) return { ok: false, response: json({ error: "site not found" }, 404) };
  const { actor } = await requirePermission(request, view.site, "site.sharing.manage");
  const share = await getShare(shareId);
  if (!share || share.siteId !== view.site.id) return { ok: false, response: json({ error: "share not found" }, 404) };
  return { ok: true, site: view.site, share, actor };
}

/** Fixed links are read/comment only; a foreign version is never a fallback to current. */
export async function parseShareAuthorization(body: Record<string, unknown>, siteId: string, previous?: Share): Promise<{mode: Share["mode"]; versionId: string | null}> {
  const mode = body.mode === undefined ? previous?.mode ?? "view" : body.mode;
  if (mode !== "view" && mode !== "comment" && mode !== "edit") throw new ShareInputError("mode must be view, comment or edit");
  const versionId = body.versionId === undefined ? previous?.versionId ?? null : body.versionId;
  if (versionId !== null && (typeof versionId !== "string" || !versionId)) throw new ShareInputError("versionId must be a version id or null");
  if (versionId) {
    const { getVersion } = await import("@/lib/db");
    const version = await getVersion(versionId);
    if (!version || version.siteId !== siteId) throw new ShareInputError("Version does not belong to this site");
    if (mode === "edit") throw new ShareInputError("Fixed-version links cannot grant editing");
  }
  return { mode, versionId };
}
