import { rbacQuery, toSite } from "@/lib/db";
import { sharingSession, getSiteSharing } from "@/lib/sharing-defaults";
import { errorResponse, privateJson as json } from "@/app/api/_util";
export async function GET(request: Request) {
  try {
    const session = await sharingSession(request);
    const slugs = [
      ...new Set(new URL(request.url).searchParams.getAll("slug")),
    ].slice(0, 100);
    const states: Record<
      string,
      Awaited<ReturnType<typeof getSiteSharing>>
    > = {};
    if (slugs.length) {
      const rows = await rbacQuery(
        `SELECT * FROM sites WHERE owner_id=$1 AND deleted_at IS NULL AND slug IN (${slugs.map((_, i) => `$${i + 2}`).join(",")})`,
        [session.userId, ...slugs],
      );
      for (const row of rows)
        states[String(row.slug)] = await getSiteSharing(toSite(row));
    }
    const scopes = await rbacQuery(
      "SELECT folder_id FROM sharing_scopes WHERE owner_id=$1 AND enabled=1",
      [session.userId],
    );
    const response = json({
      states,
      sharedFolders: scopes
        .filter((r) => r.folder_id)
        .map((r) => String(r.folder_id)),
      allShared: scopes.some((r) => !r.folder_id),
    });
    response.headers.set("cache-control", "private, no-store");
    return response;
  } catch (e) {
    return errorResponse(e);
  }
}
