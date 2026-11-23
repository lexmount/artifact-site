// Legacy slug-addressed APIs remain available for operator scripts.
import { deleteAdminSite, patchAdminSite } from "../_mutations";
type Context = { params: Promise<{ slug: string }> };
export async function PATCH(request: Request, context: Context) {
  return patchAdminSite(request, (await context.params).slug);
}
export async function DELETE(request: Request, context: Context) {
  return deleteAdminSite(request, (await context.params).slug);
}
