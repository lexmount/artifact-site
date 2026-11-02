import { rbacQuery } from "@/lib/db";
import type { Site } from "@/lib/types";

/** Call only after the read gate. Legacy display names may contain private login identifiers. */
export async function siteAuthorName(site: Pick<Site, "ownerId">): Promise<string | null | undefined> {
  if (!site.ownerId) return null;
  const [owner] = await rbacQuery("SELECT public_display_name FROM users WHERE id=$1", [site.ownerId]);
  return typeof owner?.public_display_name === "string" ? owner.public_display_name : undefined;
}
