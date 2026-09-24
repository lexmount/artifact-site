import { commentResponse, assertNoCommentQuery, type CommentRouteContext } from "@/lib/comments/http";
import { COMMENT_ATTACHMENT_MAX_BYTES, uploadCommentAttachment, preflightCommentImage } from "@/lib/comments/attachments";
import { CommentImageError } from "@/lib/errors";
import { fail } from "@/lib/comments/store";
/** Bound the raw multipart stream before invoking formData, including chunked requests. */
export async function POST(request: Request, context: CommentRouteContext) {
  let resized = false;
  const response = await commentResponse(async () => {
    assertNoCommentQuery(request);
    await preflightCommentImage(request);
    const maximum = COMMENT_ATTACHMENT_MAX_BYTES + 64 * 1024;
    if (Number(request.headers.get("content-length")) > maximum) throw new CommentImageError(413,"image_too_large","Image request is too large");
    const reader = request.body?.getReader();
    if (!reader) return fail(400,"Image required");
    const chunks: Uint8Array[] = []; let size=0;
    while (true) {
      const {done,value} = await reader.read(); if (done) break;
      size += value.length;
      if (size > maximum) {await reader.cancel();throw new CommentImageError(413,"image_too_large","Image request is too large");}
      chunks.push(value);
    }
    const parsed = new Request(request.url,{method:"POST",headers:request.headers,body:Buffer.concat(chunks)});
    let form: FormData;
    try { form = await parsed.formData(); } catch { return fail(400,"Invalid multipart image upload"); }
    if (form.getAll("file").length !== 1 || form.getAll("scope").length !== 1 || [...form.keys()].some(k=>k!=="file" && k!=="scope")) fail(400,"Expected one image and discussion scope");
    const file = form.get("file"), scope = form.get("scope");
    if (!(file instanceof File) || typeof scope !== "string") return fail(400,"Expected one image and discussion scope");
    let decodedScope: unknown;
    try { decodedScope = JSON.parse(scope); } catch { return fail(400,"Invalid discussion scope"); }
    return uploadCommentAttachment(request,(await context.params).slug,decodedScope,file,value => {resized=value;});
  },201);
  if (response.ok && resized) response.headers.set("x-artifact-image-resized","true");
  return response;
}
