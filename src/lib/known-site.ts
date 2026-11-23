import "server-only";
import { getSite, getSiteBySlug } from "@/lib/db";
import { BadRequestError } from "@/lib/errors";
import { requestBase } from "@/lib/public-base";

/** Resolve one supplied identifier, never a title search, prefix search or remote fetch. */
export async function knownSite(request: Request, input: string) {
  let reference = input.trim();
  if (!reference || reference.length > 2048) throw new BadRequestError("Enter an exact site address, slug or ID");
  if (reference.includes("/")) {
    const base = new URL(requestBase(request));
    let url: URL;
    try { url = new URL(reference, base); }
    catch { throw new BadRequestError("Invalid site address"); }
    const prefix = `${base.pathname.replace(/\/$/, "")}/s/`;
    if (url.origin !== base.origin || url.username || url.password || !url.pathname.startsWith(prefix))
      throw new BadRequestError("Use a site address on this server");
    reference = url.pathname.slice(prefix.length).replace(/\/$/, "");
  }
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(reference)) throw new BadRequestError("Enter an exact site address, slug or ID");
  const site = (reference.startsWith("site_") ? await getSite(reference) : null) ?? await getSiteBySlug(reference);
  if (!site) throw Object.assign(new Error("Site not found"), { statusCode: 404 });
  return site;
}
