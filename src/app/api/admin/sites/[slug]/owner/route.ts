import { assignAdminSiteOwner } from "../../_mutations";
export async function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  return assignAdminSiteOwner(request, (await context.params).slug);
}
