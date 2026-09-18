import "server-only";
import { json, errorResponse } from "@/app/api/_util";
import { fail } from "./store";
export type CommentRouteContext<
  T extends Record<string, string> = { slug: string },
> = { params: Promise<T> };
export async function commentResponse(
  work: () => Promise<unknown>,
  status = 200,
) {
  try {
    const response = json(await work(), status);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
}
export function queryObject(request: Request) {
  const query: Record<string, string> = Object.create(null);
  for (const [key, value] of new URL(request.url).searchParams) {
    if (Object.hasOwn(query, key)) fail(400, "Duplicate query parameter");
    query[key] = value;
  }
  return query;
}
export function assertNoCommentQuery(request: Request) {
  if (new URL(request.url).searchParams.size)
    fail(400, "Unknown query parameter");
}
export async function commentBody(request: Request) {
  assertNoCommentQuery(request);
  const maximum = 64 * 1024;
  if (Number(request.headers.get("content-length")) > maximum)
    fail(413, "Comment request is too large");
  const reader = request.body?.getReader();
  if (!reader) return fail(400, "Request body required");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      return fail(413, "Comment request is too large");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
