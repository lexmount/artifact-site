import { sharingCollection } from "@/lib/sharing-defaults";
import { errorResponse, json } from "@/app/api/_util";
export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  try {
    const response = json(
      await sharingCollection(request, (await context.params).token),
    );
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (e) {
    return errorResponse(e);
  }
}
