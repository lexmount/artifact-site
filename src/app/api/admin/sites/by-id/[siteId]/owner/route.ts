import { assignAdminSiteOwner } from "../../../_mutations";
export async function POST(request: Request, context: { params: Promise<{ siteId: string }> }) {
  return assignAdminSiteOwner(request, { id: (await context.params).siteId });
}
