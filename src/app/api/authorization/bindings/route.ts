import {
  listBindings,
  mutateBinding,
  resourceFromRequest,
} from "@/lib/authorization";
import { errorResponse } from "../../_util";
export async function GET(request: Request) {
  try {
    return Response.json(
      await listBindings(request, resourceFromRequest(request)),
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: Request) {
  try {
    return Response.json(await mutateBinding(request, await request.json()), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
