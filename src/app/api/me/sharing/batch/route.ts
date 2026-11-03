import { batchSharing } from "@/lib/bulk-sharing";
import { errorResponse, privateJson } from "@/app/api/_util";
export async function POST(request: Request) {
  try { return privateJson(await batchSharing(request, await request.json())); }
  catch (error) { return errorResponse(error); }
}
