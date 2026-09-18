// GET /api/auth/me — current user, or null. Never 401 for a browser: the UI asks this on every
// page, including the fully anonymous read path, and an error status there would be noise rather
// than signal. The one exception is a presented-but-dead Bearer: an agent checking its token
// before publishing needs the refusal and its reason (`code`), not a quiet `user: null`.
import { NextResponse } from "next/server";
import { getUser } from "@/lib/db";
import { resolveSession } from "@/lib/session";
import { config, limits } from "@/lib/config";
import { resolveAdmin } from "@/lib/admin";
import { assertPresentedBearerAlive } from "@/lib/auth";
import { errorResponse, json } from "../../_util";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await resolveSession(request);
    await assertPresentedBearerAlive(request, session);
    // oidcEnabled lets the client hide every auth affordance while no IdP is configured, so
    // an unconfigured deployment looks and behaves exactly as it did before identity existed.
    const oidcEnabled = config.oidcEnabled;
    const uploadLimits = { maxBytes: limits.maxBytes, maxFileBytes: limits.maxFileBytes, maxFiles: limits.maxFiles };
    if (!session) return json({ user: null, oidcEnabled, uploadLimits }, 200);
    const user = await getUser(session.userId);
    if (!user) return json({ user: null, oidcEnabled, uploadLimits }, 200);
    return json({
      user: { id: user.id, email: user.email, displayName: user.displayName, avatarUrl: user.avatarUrl },
      oidcEnabled, uploadLimits,
      // Lets the shell show the "Administration" entry; the console re-checks on every request.
      isAdmin: (await resolveAdmin(request, session)) != null,
    }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}
