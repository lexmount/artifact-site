import * as folders from "@/app/api/me/folders/route";
import * as assignments from "@/app/api/me/folders/assignments/route";
import * as commentResult from "@/app/api/sites/[slug]/comments/[threadId]/result/route";
import * as commentList from "@/app/api/sites/[slug]/comments/agent-list/route";
import * as commentDetail from "@/app/api/sites/[slug]/comments/[threadId]/route";
import * as commentMessages from "@/app/api/sites/[slug]/comments/[threadId]/messages/route";
import * as commentContext from "@/app/api/sites/[slug]/comments/[threadId]/agent-context/route";
import * as operationStatus from "@/app/api/operations/[key]/route";
import * as uploadStatus from "@/app/api/uploads/[versionId]/route";
// Explicit in-process route dispatch: reuse the HTTP permission/business boundary without
// forwarding credentials to an arbitrary URL or requiring a loopback network connection.
import * as collection from "@/app/api/sites/route";
import * as site from "@/app/api/sites/[slug]/route";
import * as versions from "@/app/api/sites/[slug]/versions/route";
import * as edit from "@/app/api/sites/[slug]/edit/route";
import * as fork from "@/app/api/sites/[slug]/fork/route";
import * as rollback from "@/app/api/sites/[slug]/rollback/route";
import * as shares from "@/app/api/sites/[slug]/shares/route";
import * as search from "@/app/api/search/route";
import * as read from "@/app/api/sites/[slug]/text/route";
import * as mine from "@/app/api/me/sites/route";
import * as me from "@/app/api/auth/me/route";
import * as uploads from "@/app/api/uploads/route";
import * as commit from "@/app/api/uploads/[versionId]/commit/route";
import * as uploadFile from "@/app/api/uploads/[versionId]/files/[...relpath]/route";

import * as official from "@/app/api/sites/[slug]/official/route";

export type Operation = "public_list" | "folders" | "move" | "comment_result" | "comments_list" | "comment_read" | "comment_messages" | "comment_context" | "operation_status" | "upload_status" | "official" | "official_set" | "official_clear" | "publish" | "get" | "rename" | "delete" | "versions" | "update" | "edit" | "fork" | "rollback" | "share" | "shares" | "search" | "read" | "list" | "whoami" | "upload_start" | "upload_file" | "upload_commit";
export function apiRequest(source: Request, route: string, method = "GET", body?: BodyInit) {
  const url = new URL(route, source.url);
  const authorization = source.headers.get("authorization")!;
  const headers = new Headers({ authorization, origin: url.origin });
  for (const name of ["x-real-ip", "x-forwarded-for", "x-artifact-share", "x-artifact-tenant", "idempotency-key", "x-artifact-operation-input"]) { const value = source.headers.get(name); if (value) headers.set(name, value); }
  if (typeof body === "string") headers.set("content-type", "application/json");
  return new Request(url, { method, headers, body, signal: source.signal, ...(body instanceof ReadableStream ? { duplex: "half" } : {}) });
}
export async function callApi(source: Request, op: Operation, args: { threadId?: string; key?: string; slug?: string; versionId?: string; file?: string; query?: Record<string, string>; body?: unknown; raw?: BodyInit } = {}) {
  const slug = args.slug ?? "";
  const versionId = args.versionId ?? "";
  const params = { params: Promise.resolve({ threadId: args.threadId ?? "", key: args.key ?? "", slug, versionId, relpath: (args.file ?? "").split("/") }) };
  const item = `/api/sites/${encodeURIComponent(slug)}`;
  const query = args.query ? `?${new URLSearchParams(args.query)}` : "";
  const thread = `${item}/comments/${encodeURIComponent(args.threadId ?? "")}`;
  const routes = {
    public_list: ["GET", "/api/sites", collection.GET],
    folders: ["GET", "/api/me/folders", folders.GET],
    move: ["PUT", "/api/me/folders/assignments", assignments.PUT],
    comments_list: ["GET", `${item}/comments/agent-list`, commentList.GET],
    comment_read: ["GET", thread, commentDetail.GET],
    comment_messages: ["GET", `${thread}/messages`, commentMessages.GET],
    comment_result: ["PATCH", `${thread}/result`, commentResult.PATCH],
    comment_context: ["GET", `${thread}/agent-context`, commentContext.GET],
    operation_status: ["GET", `/api/operations/${encodeURIComponent(args.key ?? "")}`, operationStatus.GET],
    upload_status: ["GET", `/api/uploads/${versionId}`, uploadStatus.GET],
    official: ["GET", `${item}/official`, official.GET], official_set: ["PUT", `${item}/official`, official.PUT], official_clear: ["DELETE", `${item}/official`, official.DELETE],
    publish: ["POST", "/api/sites", collection.POST], get: ["GET", item, site.GET], rename: ["PATCH", item, site.PATCH], delete: ["DELETE", item, site.DELETE],
    versions: ["GET", `${item}/versions`, versions.GET], update: ["POST", `${item}/versions`, versions.POST], edit: ["POST", `${item}/edit`, edit.POST],
    fork: ["POST", `${item}/fork`, fork.POST], rollback: ["POST", `${item}/rollback`, rollback.POST], share: ["POST", `${item}/shares`, shares.POST], shares: ["GET", `${item}/shares`, shares.GET],
    search: ["GET", "/api/search", search.GET], read: ["GET", `${item}/text`, read.GET], list: ["GET", "/api/me/sites", mine.GET], whoami: ["GET", "/api/auth/me", me.GET],
    upload_start: ["POST", "/api/uploads", uploads.POST], upload_commit: ["POST", `/api/uploads/${versionId}/commit`, commit.POST], upload_file: ["PUT", `/api/uploads/${versionId}/files/${args.file}`, uploadFile.PUT],
  } as const;
  const [method, route, handler] = routes[op];
  const body = args.raw ?? (args.body === undefined ? undefined : args.body instanceof FormData ? args.body : JSON.stringify(args.body));
  // MCP already bounds and decodes the tool payload in memory. Finish multipart encoding
  // before dispatch: cancelling undici's live FormData producer on a 413 can reject later
  // outside the route's error boundary. A Blob also lets the size gate reject before reading.
  const encoded = body instanceof FormData ? new Response(body) : undefined;
  const wireBody = encoded ? await encoded.blob() : body;
  const request = apiRequest(source, route + query, method, wireBody);
  if (encoded && wireBody instanceof Blob) {
    request.headers.set("content-type", encoded.headers.get("content-type")!);
    request.headers.set("content-length", String(wireBody.size));
  }
  const response = await handler(request, params);
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error ?? "Operation failed"), { statusCode: response.status, data });
  return data;
}
