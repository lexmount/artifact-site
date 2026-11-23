import { deleteAdminSite, patchAdminSite } from "../../_mutations";
type Context = { params: Promise<{ siteId: string }> };
export async function PATCH(request: Request, context: Context) {
  return patchAdminSite(request, { id: (await context.params).siteId });
}
export async function DELETE(request: Request, context: Context) {
  return deleteAdminSite(request, { id: (await context.params).siteId });
}
