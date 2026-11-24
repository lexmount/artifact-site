// Administrative mutation responses omit the site's management credentials.
import type { Site } from "@/lib/types";

export function adminSite(row: Site) {
  const { editToken: _e, anonOwnerId, ...rest } = row;
  void _e;
  return { ...rest, anonymous: !row.ownerId, hasAnonymousOwner: Boolean(anonOwnerId) };
}
