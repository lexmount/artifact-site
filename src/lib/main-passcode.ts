import "server-only";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { createId, rbacQuery } from "@/lib/db";
import type { RbacQuery } from "@/lib/rbac-store";
import type { Site } from "@/lib/types";
import { createPasscode, hashPasscode } from "@/lib/share";
import { safeEqual } from "@/lib/crypto";
import { isSecureRequest } from "@/lib/http";
import { mainSharingActive } from "@/lib/sharing-read";
import { tenantActive } from "@/lib/rbac-access";

type Passcode = { id: string; ciphertext: string; passcode_hash: string };
const ttl = 12 * 60 * 60 * 1000;
// Like preview secrets, this shared key is outside the public settings catalogue. It is
// separate from rotatable preview keys so that rotation cannot destroy saved passcodes.
async function key(q: RbacQuery = rbacQuery): Promise<Buffer> {
  const [existing] = await q("SELECT secret FROM main_passcode_secret WHERE id='active'");
  if (existing) return Buffer.from(String(existing.secret), "hex");
  await q("INSERT INTO main_passcode_secret(id,secret) VALUES('active',$1) ON CONFLICT(id) DO NOTHING", [randomBytes(32).toString("hex")]);
  const [row] = await q("SELECT secret FROM main_passcode_secret WHERE id='active'");
  return Buffer.from(String(row.secret), "hex");
}
async function stored(siteId: string, q: RbacQuery): Promise<Passcode | null> {
  const [row] = await q("SELECT id,ciphertext,passcode_hash FROM main_link_passcodes WHERE site_id=$1", [siteId]);
  return row ? row as unknown as Passcode : null;
}
function aad(siteId: string, id: string) { return Buffer.from(`main-passcode-v1|${siteId}|${id}`); }
/** Only call after checking site.sharing.manage; never include in public sharing state. */
export async function managedMainPasscode(siteId: string, q: RbacQuery = rbacQuery): Promise<string | null> {
  const row = await stored(siteId, q);
  if (!row) return null;
  const bytes = Buffer.from(row.ciphertext, "base64url");
  const cipher = createDecipheriv("aes-256-gcm", await key(q), bytes.subarray(0, 12));
  cipher.setAAD(aad(siteId, row.id));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString();
}
/** Run inside the sharing transaction: enabling generates once; leaving destroys old proof. */
export async function syncMainPasscode(q: RbacQuery, siteId: string, enabled: boolean, reset = false) {
  if (!enabled) { await q("DELETE FROM main_link_passcodes WHERE site_id=$1", [siteId]); return; }
  const old = await stored(siteId, q);
  if (old && !reset) return;
  let code = createPasscode();
  while (old?.passcode_hash === hashPasscode(code)) code = createPasscode();
  const id = createId("mcode"), nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await key(q), nonce);
  cipher.setAAD(aad(siteId, id));
  const ciphertext = Buffer.concat([cipher.update(code), cipher.final()]);
  await q("INSERT INTO main_link_passcodes(site_id,id,ciphertext,passcode_hash) VALUES($1,$2,$3,$4) ON CONFLICT(site_id) DO UPDATE SET id=excluded.id,ciphertext=excluded.ciphertext,passcode_hash=excluded.passcode_hash", [siteId, id, Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url"), hashPasscode(code)]);
}
export async function activeMainPasscode(site: Site): Promise<Passcode | null> {
  if (site.deletedAt || site.takenDownAt || !(await tenantActive(site.tenantId)) || !(await mainSharingActive(site))) return null;
  const [state] = await rbacQuery("SELECT audience FROM site_sharing_state WHERE site_id=$1", [site.id]);
  return state?.audience === "passcode" ? stored(site.id, rbacQuery) : null;
}
function cookieName(request: Request, siteId: string) { return `${isSecureRequest(request) ? "__Host-" : ""}ah_main_${siteId}`; }
async function proof(siteId: string, id: string, expires: number) {
  return createHmac("sha256", await key()).update(`main-passcode-cookie-v1|${siteId}|${id}|${expires}`).digest("base64url");
}
export async function mainPasscodeCookie(request: Request, site: Site, id: string) {
  const expires = Date.now() + ttl;
  return `${cookieName(request, site.id)}=${expires}.${await proof(site.id, id, expires)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttl / 1000}${isSecureRequest(request) ? "; Secure" : ""}`;
}
export async function admittedMainPasscode(request: Request, site: Site): Promise<Passcode | null> {
  // Ordinary visitors carry no passcode cookie; do not add database reads to their access path.
  const prefix = `${cookieName(request, site.id)}=`;
  const matches = (request.headers.get("cookie") ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith(prefix));
  if (matches.length !== 1) return null;
  const [expiry, digest, ...extra] = matches[0].slice(prefix.length).split(".");
  const expires = Number(expiry);
  if (extra.length || !Number.isSafeInteger(expires) || expires <= Date.now() || expires > Date.now() + ttl || !digest) return null;
  const row = await activeMainPasscode(site);
  if (!row) return null;
  return safeEqual(digest, await proof(site.id, row.id, expires)) ? row : null;
}
export async function mainPasscodeRole(request: Request, site: Site) {
  if (!(await admittedMainPasscode(request, site))) return null;
  const [row] = await rbacQuery("SELECT comments FROM site_sharing_state WHERE site_id=$1", [site.id]);
  return Number(row?.comments) ? "commenter" as const : "viewer" as const;
}
