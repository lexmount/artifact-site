import { availableRoles, resourceFromRequest } from "@/lib/authorization";
import { errorResponse } from "../../_util";
export async function GET(request: Request) {
  try {
    return Response.json(
      await availableRoles(
        request,
        resourceFromRequest(request),
        new URL(request.url).searchParams.get("subjectType") ?? "user",
      ),
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
