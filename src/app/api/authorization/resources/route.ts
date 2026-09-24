import { authorizationResources } from "@/lib/authorization";
import { errorResponse } from "../../_util";
export async function GET(request: Request) {
  try {
    return Response.json(await authorizationResources(request), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
