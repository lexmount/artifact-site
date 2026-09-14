import "server-only";

// The CSRF rule of the chunked upload path, shared by the PUT-file and commit steps.
//
// A session that targets an EXISTING site was opened under the same gate as POST …/versions: an
// Origin is required whenever authorization rode credentials the browser attached by itself
// (session or anonymous cookie), and never for a deliberate header (edit token, admin Bearer,
// publish token). The later steps are keyed by the unguessable versionId, but they still ride the
// same cookies, so they repeat the check rather than trust that the opener was honest. A session
// for a NEW site stays ungated all the way through, like POST /api/sites — it rides nobody's
// identity, and a scripted anonymous publish sends no Origin at all.
//
// A boolean rather than a throw: the commit route's catch block discards the session on any
// failure, and a forged request must not be able to destroy an honest upload in progress.
import { editTokenFromRequest, isAdmin } from "@/lib/auth";
import { csrfSafe } from "@/lib/session";

export function isCrossSiteForTarget(request: Request, session: { targetSlug?: string | null }): boolean {
  if (!session.targetSlug) return false;
  const deliberate = Boolean(editTokenFromRequest(request)) || isAdmin(request);
  return !deliberate && !csrfSafe(request);
}

export const CROSS_SITE_REJECTED = "Cross-site request rejected";
