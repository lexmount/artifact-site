import "server-only";
import { assertMutationOrigin, MutationOriginError } from "@/lib/request-auth";
import { getSiteView } from "@/lib/sites";
export async function isCrossSiteForTarget(request: Request, session: { targetSlug?: string | null }): Promise<boolean> {
  const view = session.targetSlug ? await getSiteView(session.targetSlug) : null;
  try { await assertMutationOrigin(request, view?.site); return false; }
  catch (error) { if (error instanceof MutationOriginError) return true; throw error; }
}
export const CROSS_SITE_REJECTED = "Cross-site request rejected";
