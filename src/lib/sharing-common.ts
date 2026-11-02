import "server-only";
import { createHash } from "node:crypto";
import type { Row } from "@/lib/db";
import type { SharingPolicy } from "@/lib/sharing-policy";
import { resolveSession, csrfSafe } from "@/lib/session";
import { AuthError, EditForbiddenError } from "@/lib/auth";
import { SCOPE_WRITE } from "@/lib/oauth-shared";
export function fail(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode });
}
export const visibility = (p: SharingPolicy) =>
  p.audience === "public"
    ? "public"
    : p.audience === "anyone"
      ? "unlisted"
      : "private";
export const rowPolicy = (r: Row): SharingPolicy => ({
  audience: r.audience as SharingPolicy["audience"],
  comments: Number(r.comments) === 1,
});
export function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export async function sharingSession(request: Request, write = false) {
  const session = await resolveSession(request);
  if (!session) throw new AuthError("Please sign in first");
  if (
    write &&
    (!csrfSafe(request) ||
      (session.scopes && !session.scopes.includes(SCOPE_WRITE)))
  )
    throw new EditForbiddenError(
      "Sharing changes require a same-origin write credential",
    );
  return session;
}
