import { z } from "zod";
import { moveSharing } from "@/lib/sharing-defaults";
import { errorResponse, privateJson as json } from "@/app/api/_util";
export async function POST(request: Request) {
  try {
    const body = z
      .object({
        slugs: z.array(z.string()).min(1).max(100),
        folderId: z.string().nullable(),
        confirmation: z.string().optional(),
      })
      .strict()
      .parse(await request.json());
    return json(
      await moveSharing(request, body.slugs, body.folderId, body.confirmation),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
