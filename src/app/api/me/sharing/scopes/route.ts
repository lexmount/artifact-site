import { z } from "zod";
import { getScope, scopeChange } from "@/lib/sharing-defaults";
import { errorResponse, privateJson as json } from "@/app/api/_util";
export async function GET(request: Request) {
  try {
    return json(
      await getScope(
        request,
        new URL(request.url).searchParams.get("folderId") || null,
      ),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: Request) {
  try {
    const { folderId, ...input } = z
      .object({ folderId: z.string().nullable() })
      .passthrough()
      .parse(await request.json());
    return json(await scopeChange(request, folderId, input));
  } catch (e) {
    return errorResponse(e);
  }
}
