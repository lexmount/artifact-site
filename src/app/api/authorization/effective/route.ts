import {
  effectiveAuthorization,
  resourceFromRequest,
} from "@/lib/authorization";
import { errorResponse } from "../../_util";
export async function GET(request: Request) {
  try {
    return Response.json(
      await effectiveAuthorization(request, resourceFromRequest(request)),
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
