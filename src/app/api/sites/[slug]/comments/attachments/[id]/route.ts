import { commentResponse, assertNoCommentQuery, type CommentRouteContext } from "@/lib/comments/http";
import { readCommentAttachment, discardCommentAttachment } from "@/lib/comments/attachments";
import { errorResponse } from "@/app/api/_util";
type Context = CommentRouteContext<{slug:string;id:string}>;
export async function GET(request: Request, context: Context) {
  try {
    assertNoCommentQuery(request);
    const {slug,id} = await context.params;
    const {attachment,bytes} = await readCommentAttachment(request,slug,id);
    return new Response(new Uint8Array(bytes),{headers:{"Content-Type":attachment.mimeType,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; sandbox","Content-Disposition":"inline"}});
  } catch (error) {const response=errorResponse(error);response.headers.set("Cache-Control","private, no-store");return response;}
}
export function DELETE(request: Request, context: Context) {
  return commentResponse(async()=>{assertNoCommentQuery(request);const {slug,id}=await context.params;return discardCommentAttachment(request,slug,id);});
}
