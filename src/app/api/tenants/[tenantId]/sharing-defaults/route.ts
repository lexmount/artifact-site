import {
  getSharingPreference,
  setSharingPreference,
} from "@/lib/sharing-defaults";
import { sharingPolicySchema } from "@/lib/sharing-policy";
import { errorResponse, privateJson as json } from "@/app/api/_util";
type Context = { params: Promise<{ tenantId: string }> };
export async function GET(request: Request, context: Context) {
  try {
    return json(
      await getSharingPreference(
        request,
        (await context.params).tenantId,
        true,
      ),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
export async function PUT(request: Request, context: Context) {
  try {
    return json(
      await setSharingPreference(
        request,
        (await context.params).tenantId,
        sharingPolicySchema.parse(await request.json()),
        true,
      ),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
