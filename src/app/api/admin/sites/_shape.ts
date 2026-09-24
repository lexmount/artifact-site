// What an administrator sees of a site. The three per-site secrets stay out even here: the
// console never needs them, and an administrator's session is the most valuable one to steal.
import type { AdminSiteRow, Site } from "@/lib/types";

export function adminSite(row: AdminSiteRow | Site) {
  const { editToken: _e, anonOwnerId, ...rest } = row as AdminSiteRow;
  void _e;
  // The anonymous owner id is a credential; the console only needs to know whether there is one.
  return { ...rest, anonymous: !("ownerId" in row && row.ownerId) , hasAnonymousOwner: Boolean(anonOwnerId) };
}
