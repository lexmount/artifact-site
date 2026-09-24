import { rbacQuery } from "@/lib/db";
import { POST } from "@/app/api/authorization/bindings/route";
import { PATCH } from "@/app/api/authorization/bindings/[id]/route";
/** Exercise the binding API from permission-matrix fixtures. */
export async function grantMember(request: Request, context: { params: Promise<{slug: string}> }) {
  const { email, role = "editor" } = await request.json();
  const [site] = await rbacQuery("SELECT id FROM sites WHERE slug=$1", [(await context.params).slug]);
  const [user] = await rbacQuery("SELECT id FROM users WHERE email=$1", [email]);
  const [binding] = await rbacQuery("SELECT id,revision FROM role_bindings WHERE resource_site_id=$1 AND subject_user_id=$2", [String(site.id),String(user.id)]);
  const roleId = role === "admin" ? "site-admin" : role;
  const req = new Request(request.url, {method: binding ? "PATCH" : "POST",headers: request.headers,body:JSON.stringify(binding
    ? { roleId, expectedRevision:Number(binding.revision) }
    : {resource:{type:"site",id:site.id},subject:{type:"user",id:user.id},roleId})});
  return binding ? PATCH(req, {params:Promise.resolve({id:String(binding.id)})}) : POST(req);
}
