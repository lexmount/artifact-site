import { requireAdmin } from "@/lib/admin";
import { tenantSlug } from "@/lib/tenant-management";
import { rbacQuery } from "@/lib/db";
import { errorResponse, json } from "@/app/api/_util";
export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const slug = tenantSlug(new URL(request.url).searchParams.get("slug"));
    const rows = await rbacQuery("SELECT id FROM tenants WHERE LOWER(COALESCE(slug,id))=$1", [slug]);
    return json({ slug, available: rows.length === 0 });
  } catch (error) { return errorResponse(error); }
}
