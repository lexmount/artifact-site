import "server-only";
import { getShareByTokenHash, getSite, getSiteBySlug } from "@/lib/db";
import { sha256hex } from "@/lib/crypto";
import { BadRequestError } from "@/lib/errors";
import { requestBase } from "@/lib/public-base";

/** Resolve one supplied identifier, never a title search, prefix search or remote fetch. */
export async function knownSite(request: Request, input: string) {
  let reference = input.trim();
  let byId = reference.startsWith("site_");
  if (!reference || reference.length > 2048) throw new BadRequestError("Enter an exact site address, slug or ID");
  if (reference.includes("/")) {
    const base = new URL(requestBase(request));
    let url: URL;
    try { url = new URL(reference, base); }
    catch { throw new BadRequestError("Invalid site address"); }
    const prefix = `${base.pathname.replace(/\/$/, "")}/`;
    if (url.origin !== base.origin || url.username || url.password || !url.pathname.startsWith(prefix))
      throw new BadRequestError("Use a site address on this server");
    const [route, identifier, ...tail] = url.pathname.slice(prefix.length).replace(/\/$/, "").split("/");
    if (route === "c") throw new BadRequestError("Collection links identify multiple sites; enter a site address or ID");
    if (!identifier || !/^[A-Za-z0-9_-]{1,200}$/.test(identifier)) throw new BadRequestError("Enter an exact site address, slug or ID");
    if (route === "s" && (tail.length === 0 || (tail.length === 1 && ["comments", "edit"].includes(tail[0])))) {
      reference = identifier;
      byId = false;
    } else if (route === "v" && tail.length === 0) {
      // A share identifies a target; it never supplies management authority.
      const share = await getShareByTokenHash(sha256hex(identifier));
      if (!share) throw Object.assign(new Error("Site not found"), { statusCode: 404 });
      reference = share.siteId;
      byId = true;
    } else throw new BadRequestError("Use a site address on this server");
  }
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(reference)) throw new BadRequestError("Enter an exact site address, slug or ID");
  const site = byId ? await getSite(reference) : await getSiteBySlug(reference);
  if (!site) throw Object.assign(new Error("Site not found"), { statusCode: 404 });
  return site;
}
