// GET /api/admin/users?q=&sort=recent|storage|sites&disabled=1&limit=&offset= — accounts with
// their live site count and stored bytes (every version of every site they own).
import type { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminUser, requireAdmin } from "@/lib/admin";
import { checkRateLimit } from "@/lib/ratelimit";
import { listUsersAdmin } from "@/lib/db";
import { policy } from "@/lib/settings";
import type { AdminUserRow } from "@/lib/types";
import { errorResponse, json } from "../../_util";

const query = z.object({
  q: z.string().trim().max(200).default(""),
  sort: z.enum(["recent", "storage", "sites"]).default("recent"),
  disabled: z.enum(["1", "0", ""]).default(""),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function GET(request: Request): Promise<NextResponse> {
  try {
    checkRateLimit(request); // the aggregates below are the priciest reads in the app
    await requireAdmin(request);
    const p = query.parse(Object.fromEntries(new URL(request.url).searchParams));
    const { rows, total } = await listUsersAdmin({ q: p.q, sort: p.sort, disabledOnly: p.disabled === "1", limit: p.limit, offset: p.offset });
    const q = policy.quota;
    return json({ users: rows.map(publicUser), total, limit: p.limit, offset: p.offset, quota: { sites: q.sitesPerUser, bytes: q.bytesPerUser } });
  } catch (error) {
    return errorResponse(error);
  }
}

/** The console never needs the IdP subject; leave it out of every response. `isAdmin` lets the
 *  table say "administrator" instead of offering a Disable button the API would refuse. */
function publicUser(u: AdminUserRow) {
  const { providerSubject: _subject, ...rest } = u;
  void _subject;
  return { ...rest, isAdmin: isAdminUser(u) };
}
