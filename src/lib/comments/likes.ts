import "server-only";
import { createId, rbacTransaction, toSite } from "@/lib/db";
import { assertSessionCurrent } from "@/lib/authorized-commit";
import { assertPresentedBearerAlive } from "@/lib/auth";
import { resolveSession, csrfSafe } from "@/lib/session";
import { randomBytes } from "node:crypto";
import { isSecureRequest, readCookie } from "@/lib/http";
import { safeEqual } from "@/lib/crypto";
import { canReadVersion, requestShareAccess } from "@/lib/share";
import { checkRateLimit } from "@/lib/ratelimit";
import { SCOPE_WRITE } from "@/lib/oauth-shared";
import { commentSite } from "./service";
import { fingerprint, createFingerprintCache, fail } from "./store";
export async function siteLikes(
  request: Request,
  slug: string,
  liked?: boolean,
): Promise<{ count: number; liked: boolean; cookie: string | null }> {
  const session = await resolveSession(request);
  await assertPresentedBearerAlive(request, session);
  const initial = await commentSite(slug);
  if (
    !(await canReadVersion(
      request,
      initial,
      (await requestShareAccess(request, initial, session))?.versionId ??
        initial.currentVersionId,
      session,
    ))
  )
    fail(404, "Site not found");
  let cookie: string | null = null;
  const cookieName = isSecureRequest(request) ? "__Host-ah_like" : "ah_like";
  const rawCookie = readCookie(request, cookieName);
  const candidate =
    rawCookie && /^[A-Za-z0-9_-]{32}\.[a-f0-9]{64}$/.test(rawCookie)
      ? rawCookie.split(".")
      : null;
  if (liked !== undefined) {
    if (!csrfSafe(request)) fail(401, "Cross-site request rejected");
    checkRateLimit(request);
    if (session?.scopes && !session.scopes.includes(SCOPE_WRITE))
      fail(403, "Write scope required");
  }
  const result = await rbacTransaction(async (q) => {
    const keyCache = createFingerprintCache();
    await assertSessionCurrent(q, session);
    const [row] = await q(
      "SELECT * FROM sites WHERE id=$1 AND deleted_at IS NULL",
      [initial.id],
    );
    if (!row) fail(404, "Site not found");
    const site = toSite(row);
    if (
      !(await canReadVersion(
        request,
        site,
        (await requestShareAccess(request, site, session))?.versionId ??
          site.currentVersionId,
        session,
      ))
    )
      fail(404, "Site not found");
    if (liked !== undefined && site.takenDownAt)
      fail(403, "Site is unavailable");
    let anonId: string | null = null;
    if (
      candidate &&
      safeEqual(
        candidate[1],
        await fingerprint(
          q,
          { type: "like-cookie", id: candidate[0] },
          keyCache,
        ),
      )
    )
      anonId = candidate[0];
    if (!session && liked !== undefined && !anonId) {
      anonId = randomBytes(24).toString("base64url");
      const signature = await fingerprint(
        q,
        {
          type: "like-cookie",
          id: anonId,
        },
        keyCache,
      );
      cookie = `${cookieName}=${anonId}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=15552000${isSecureRequest(request) ? "; Secure" : ""}`;
    }
    const actor = session?.userId ?? null;
    const anonymousHash = anonId
      ? await fingerprint(q, { type: "anonymous-like", id: anonId }, keyCache)
      : null;
    // Login adopts this browser's existing like for the current site. A read-only delegated token
    // does not mutate on GET; browser login or an authorized PUT performs the atomic adoption.
    if (actor && anonymousHash && (liked !== undefined || !session?.scopes)) {
      const previous = await q(
        "SELECT id FROM reactions WHERE site_id=$1 AND message_id IS NULL AND anonymous_actor_hash=$2",
        [site.id, anonymousHash],
      );
      if (previous.length) {
        await q(
          "INSERT INTO reactions(id,site_id,message_id,kind,user_id,anonymous_actor_hash,created_at) VALUES($1,$2,NULL,'like',$3,NULL,$4) ON CONFLICT DO NOTHING",
          [createId("react"), site.id, actor, Date.now()],
        );
        await q(
          "DELETE FROM reactions WHERE site_id=$1 AND message_id IS NULL AND anonymous_actor_hash=$2",
          [site.id, anonymousHash],
        );
      }
    }
    const hash = actor ? null : anonymousHash;
    const condition = actor ? "user_id=$2" : "anonymous_actor_hash=$2";
    const key = actor ?? hash;
    if (liked !== undefined && key) {
      if (liked)
        await q(
          "INSERT INTO reactions(id,site_id,message_id,kind,user_id,anonymous_actor_hash,created_at) VALUES($1,$2,NULL,'like',$3,$4,$5) ON CONFLICT DO NOTHING",
          [createId("react"), site.id, actor, hash, Date.now()],
        );
      else
        await q(
          `DELETE FROM reactions WHERE site_id=$1 AND message_id IS NULL AND ${condition}`,
          [site.id, key],
        );
    }
    const [count] = await q(
      "SELECT count(*) AS count FROM reactions WHERE site_id=$1 AND message_id IS NULL",
      [site.id],
    );
    const existing = key
      ? await q(
          `SELECT id FROM reactions WHERE site_id=$1 AND message_id IS NULL AND ${condition}`,
          [site.id, key],
        )
      : [];
    return { count: Number(count.count), liked: existing.length > 0 };
  });
  return { ...result, cookie };
}
