import { mutateBinding } from "@/lib/authorization";
import { errorResponse } from "../../../_util";
type Context = {
  params: Promise<{
    id: string;
  }>;
};
export async function PATCH(request: Request, context: Context) {
  try {
    return Response.json(
      await mutateBinding(
        request,
        await request.json(),
        (await context.params).id,
      ),
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
export async function DELETE(request: Request, context: Context) {
  try {
    return Response.json(
      await mutateBinding(
        request,
        await request.json(),
        (await context.params).id,
        true,
      ),
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
