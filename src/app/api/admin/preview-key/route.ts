import { requireAdmin, requireAdminWrite } from "@/lib/admin";
import { previewSecretStatus, rotatePreviewSecret } from "@/lib/preview-secret";
import { checkRateLimit } from "@/lib/ratelimit";
import { errorResponse, json } from "../../_util";
export async function GET(request: Request) {
  try {
    checkRateLimit(request);
    await requireAdmin(request);
    return json(await previewSecretStatus());
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    checkRateLimit(request);
    const actor = await requireAdminWrite(request);
    const body = await request.json();
    if (!body || typeof body.revision !== "string" || !body.revision || body.revision.length > 100)
      return json({ error: "Current key revision is required" }, 400);
    return json(await rotatePreviewSecret(body.revision, actor));
  } catch (error) { return errorResponse(error); }
}
