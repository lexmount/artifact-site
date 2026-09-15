import "server-only";
import { AuthError, assertPresentedBearerAlive, isAdmin } from "@/lib/auth";
import { csrfSafe, resolveSession } from "@/lib/session";
import { resolveAuthority, resolveViewer } from "@/lib/authz";
import { anonIdFromRequest } from "@/lib/anon";
import type { Site } from "@/lib/types";
export class MutationOriginError extends AuthError {}
/** CSRF exemption requires a verified, explicitly supplied credential. Query/cookie tokens are ambient. */
export async function assertMutationOrigin(request: Request, site?: Site): Promise<void> {
    const session = await resolveSession(request);
    await assertPresentedBearerAlive(request, session);
    if (site && request.headers.get("x-edit-token")) {
        const authority = await resolveAuthority(resolveViewer(request, session), site);
        if (authority.source === "anonymous-token")
            return;
    }
    if (csrfSafe(request))
        return;
    // Credential-free anonymous creation rides no existing identity.
    if (!site && !session && !anonIdFromRequest(request) && !isAdmin(request))
        return;
    throw new MutationOriginError("Cross-site request rejected");
}
