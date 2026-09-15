import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callApi } from "./api";
import { assertUploadTarget, cancelUpload, commitUpload, CHUNK_BYTES, writeFileChunk } from "./files";
import { getSiteView } from "@/lib/sites";
import { getStorage, safeRelativePath } from "@/lib/storage";
import { requirePermission } from "@/lib/authz";
import { apiRequest } from "./api";
import { isAdmin } from "@/lib/auth";
import { BadRequestError } from "@/lib/errors";
import { limits } from "@/lib/config";
import { getSkillForBase, resolvePublicBase } from "@/lib/publish-skill";
import { readOnlyMcpTools } from "@/lib/mcp-tools";

const id = z.string().min(1).max(200);
const slug = { slug: id.describe("Artifact identifier returned by find/publish, or the slug in its /s/ URL. Not a local path.") };
const policies = z.enum(["public", "login", "people", "email", "passcode"]);
const file = z.object({ path: z.string().min(1).max(1024).describe("Relative filename in the published tree."), content: z.string().describe("Complete file contents in the chosen encoding."), encoding: z.enum(["utf8", "base64"]).default("utf8").describe("Use utf8 for text and base64 for binary bytes.") });
const content = { html: z.string().optional().describe("Complete HTML document; exclusive with files/upload_id."), files: z.array(file).min(1).optional().describe("Complete relative file tree with UTF-8 or base64 contents; exclusive with html/upload_id."), title: z.string().min(1).max(500).optional().describe("Display title; does not change the URL.") };
function uploadBody(args: { html?: string; files?: z.infer<typeof file>[]; title?: string }) {
  if ((args.html !== undefined) === (args.files !== undefined)) throw new BadRequestError("Provide exactly one of html or files");
  if (args.files) for (const item of args.files) safeRelativePath(item.path);
  if (args.html !== undefined) return { mode: "paste", html: args.html, title: args.title };
  const form = new FormData();
  form.set("mode", args.files!.length === 1 ? (args.files![0].path.endsWith(".zip") ? "zip" : "file") : "folder");
  if (args.title) form.set("title", args.title);
  for (const item of args.files!) {
    const bytes = Buffer.from(item.content, item.encoding === "base64" ? "base64" : "utf8");
    form.append(args.files!.length === 1 ? "file" : "files", new Blob([bytes]), item.path);
    if (args.files!.length > 1) form.append("paths", item.path);
  }
  return form;
}

export function createRemoteMcpServer(request: Request) {
  const publicHeaders = new Headers(request.headers);
  if (!publicHeaders.has("host")) publicHeaders.set("host", new URL(request.url).host);
  if (!publicHeaders.has("x-forwarded-proto")) publicHeaders.set("x-forwarded-proto", new URL(request.url).protocol.slice(0, -1));
  const publicBase = resolvePublicBase(publicHeaders);
  const server = new McpServer({ name: "artifact-site", version: "0.1.0" }, {
    instructions: "Artifact Site is the connected remote library for AI-generated pages, reports, charts, prototypes and documents. Use its tools when users ask about their artifacts or want to publish, find, read, update or share previous work. Start with artifact_site_find for 'my artifacts'; no slug is needed. Explicit local filesystem requests belong to local file tools. Authentication is already supplied by the host; never ask users to paste tokens into chat. Use connection only to diagnose identity/limits, not before every task. Read artifact-site://skill when building hosted content. Uploaded paths are relative filenames, never local server paths."
  });
  function tool<S extends z.ZodRawShape>(name: string, title: string, description: string, inputSchema: S, action: (args: z.infer<z.ZodObject<S>>, request: Request) => Promise<unknown>) {
    server.registerTool(name, { title, description, inputSchema: z.strictObject({...inputSchema, tenant_id:id.optional().describe("Destination tenant for creation; defaults to the account tenant."), share_token:z.string().max(512).optional().describe("Token from a user-provided share URL; carries only that share permission.")}), annotations: { idempotentHint: ["artifact_site_upload_write", "artifact_site_upload_cancel", "artifact_site_delete"].includes(name), readOnlyHint: readOnlyMcpTools.has(name), destructiveHint: ["artifact_site_update", "artifact_site_edit", "artifact_site_share", "artifact_site_rollback", "artifact_site_delete"].includes(name) } }, async (args: unknown): Promise<CallToolResult> => {
      try { request.signal.throwIfAborted(); const {tenant_id,share_token,...operationArgs} = args as Record<string,unknown>;
        const scopedHeaders = new Headers(request.headers);
        if (typeof tenant_id === "string") scopedHeaders.set("x-artifact-tenant",tenant_id);
        if (typeof share_token === "string") scopedHeaders.set("x-artifact-share",share_token);
        const scoped = new Request(request.url,{headers:scopedHeaders,signal:request.signal});
        const data = await action(operationArgs as z.infer<z.ZodObject<S>>,scoped); return { content: [{ type: "text" as const, text: JSON.stringify(data) }] }; }
      catch (error) {
        const known = error as { statusCode?: number; data?: unknown };
        if (!known.statusCode) console.error("[mcp]", name, error);
        const text = known.data ?? { error: known.statusCode ? (error as Error).message : "Operation failed", status: known.statusCode ?? 500 };
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(text) }] };
      }
    });
  }
  tool("artifact_site_connection", "Connection information", "Check which remote Artifact Site account/server is connected, diagnose authentication, or check upload size limits. Returns identity, operator status and transfer limits. Authentication is already configured; do not request a token in chat. Operator credentials have no personal library. This is optional diagnostics, not a prerequisite for finding or publishing artifacts.", {}, async (_args, request) => ({ ...await callApi(request, "whoami"), operator: isAdmin(request), baseUrl: publicBase, limits: { chunkBytes: CHUNK_BYTES, inlineRequestBytes: 2 * 1024 * 1024, maxFileBytes: limits.maxFileBytes, maxBytes: limits.maxBytes, maxFiles: limits.maxFiles, officeZipBytes: Math.max(0, limits.inlineUploadMaxBytes - 4096) }, transport: "streamable-http" }));
  const uploadId = id.optional().describe("Completed upload ID from upload_start; supply instead of html/files after all files have final:true.");
  function checkSource(args: { html?: string; files?: unknown[]; upload_id?: string }) {
    if ([args.html, args.files, args.upload_id].filter(v => v !== undefined).length !== 1) throw new BadRequestError("Provide exactly one of html, files or upload_id");
  }
  tool("artifact_site_publish", "Publish a site", "Save a new AI-generated page, report, chart, prototype or document to the remote Artifact Site library and get its address. Use for 'publish this report' or 'give this page a link'. Supply inline HTML, a UTF-8/base64 file tree, or a completed upload_id. For requests over 2 MiB, use upload_start and upload_write first. Creates a PUBLIC share by default; use share:false for unshared work. To change an existing artifact at the same URL, use update or edit instead. Returns the created artifact and share result; if sharing fails, retry share rather than publishing again.", { ...content, upload_id: uploadId, share: z.union([policies, z.literal(false)]).default("public").describe("Share policy. Defaults to public; false creates no share link.") }, async (args, request) => {
    checkSource(args);
    if (args.upload_id) await assertUploadTarget(request, args.upload_id);
    const site = args.upload_id ? await commitUpload(request, args.upload_id, args.title) : await callApi(request, "publish", { body: uploadBody(args) });
    if (!args.share) return site;
    try { return { ...site, share: await callApi(request, "share", { slug: site.slug, body: { policy: args.share } }) }; }
    catch { return { ...site, shareError: "Site created; sharing failed. Retry with artifact_site_share." }; }
  });
  tool("artifact_site_update", "Update a site", "Update an existing remote artifact while keeping its address, or rename its display title. For 'replace this report with the new version', supply exactly one of html/files/upload_id AND expected_version from get_site/export. This replaces ALL contents; omitted files are removed. For 'rename this artifact', supply only slug and title: no content version is created. Do not combine a rename-only request with upload fields. Use edit for one text file. A 409 means someone changed the artifact: inspect it before explicitly choosing what to keep; staged bytes remain available.", { ...slug, ...content, upload_id: uploadId, expected_version: id.optional().describe("Required for content replacement; version ID read before editing. Omit for title-only changes.") }, async ({ slug, expected_version, ...args }, request) => {
    if (args.html === undefined && args.files === undefined && args.upload_id === undefined) {
      if (args.title === undefined || expected_version !== undefined) throw new BadRequestError("Title-only update requires title and no expected_version");
      return callApi(request, "rename", { slug, body: { title: args.title } });
    }
    checkSource(args);
    if (!expected_version) throw new BadRequestError("expected_version is required for content replacement");
    if (args.upload_id) {
      await assertUploadTarget(request, args.upload_id, slug);
      return commitUpload(request, args.upload_id, args.title, expected_version);
    }
    return callApi(request, "update", { slug, query: { expected_version }, body: uploadBody(args) });
  });
  tool("artifact_site_edit", "Edit a file", "Change one text file in an existing remote page or website, keeping the other files and the artifact URL. Use for 'fix the heading' or 'update this chart script'. Read the file first, then submit its complete replacement text and the version you read. Creates a new version. A 409 requires reading the latest version before retrying; do not blindly overwrite a concurrent edit. Use update for a whole project or binary document.", { ...slug, path: z.string().describe("Relative text filename from get_site, such as index.html."), content: z.string().describe("Complete new text of this file, not a diff."), expected_version: id.describe("Version ID read before the edit.") }, async ({ slug, expected_version, ...body }, request) => {
    safeRelativePath(body.path);
    const site = await callApi(request, "get", { slug });
    if (site.kind === "single" && !site.files.includes(body.path)) throw new BadRequestError("path must name the single page shown by get_site");
    return callApi(request, "edit", { slug, body: { ...body, ...(site.kind === "single" ? { path: undefined } : {}) }, query: { expected_version } });
  });
  tool("artifact_site_find", "Find artifacts", "Find pages, reports, charts, prototypes and documents in the connected remote Artifact Site library. Use for 'show my artifacts', 'what have I published?', or 'find last week’s report'; no artifact URL or slug is needed. Without query, lists artifacts you own or collaborate on (personal token required). With query, searches indexed titles and contents across artifacts you may discover, including public works; every word must match. Returns identifiers and titles for get_site/read/update. Explicit requests for local files belong to filesystem tools, not this remote library.", { query: z.string().trim().min(1).max(200).optional().describe("Search words; omit to list all owned and collaborative artifacts. Search includes discoverable public works."), limit: z.number().int().min(1).max(50).optional().describe("Search result limit, default 20. Ignored when query is omitted.") }, async ({ query, limit }, request) => {
    if (!query) {
      return { scope: "mine", ...await callApi(request, "list") };
    }
    return { scope: "discoverable", ...await callApi(request, "search", { query: { q: query, limit: String(limit ?? 20) } }) };
  });
  tool("artifact_site_get_site", "Get a site", "Inspect a known remote artifact: title, kind, current version and file names. Use before editing, to check what files exist, or to review version history and sharing status. Optionally include versions and/or shares; shares require owner permissions and contain summaries, not the original secret link tokens. Metadata with filenames requires source access (editor or higher). File contents are returned by read (text) or export (original bytes).", { ...slug, include: z.array(z.enum(["versions", "shares"])).optional().describe("Optional additional details; shares require owner permission. Omit for metadata and filenames only.") }, async ({ slug, include }, request) => {
    const result = await callApi(request, "get", { slug }); delete result.content;
    if (include?.includes("versions")) Object.assign(result, await callApi(request, "versions", { slug }));
    if (include?.includes("shares")) Object.assign(result, await callApi(request, "shares", { slug }));
    return result;
  });
  tool("artifact_site_read", "Read a site", "Read an existing remote report, page or document to summarize it, answer questions, or reuse earlier work. Find its slug with find if needed. Without file, returns extracted plain text; with file, returns the original text of that relative file. Results include versionId and truncation information. Use get_site for filenames, edit to change one file, and export for binary files or a complete backup. Respects the artifact's text/AI access policy.", { ...slug, file: z.string().optional().describe("Relative text filename; omit for extracted document/page text."), max_chars: z.number().int().min(1).max(300000).default(20000).describe("Maximum returned characters; increase if the response is truncated.") }, async ({ slug, file, max_chars }, request) => callApi(request, "read", { slug, query: { ...(file ? { file } : {}), max_chars: String(max_chars) } }));
  tool("artifact_site_fork", "Fork a site", "Make an independent copy of a remote artifact, for example 'use this report as a template' or 'create my own version'. Returns a new artifact identifier and address; the source is unchanged. Requires permission to copy its contents. Use update/edit when the user wants changes at the existing address instead.", slug, async (args, request) => callApi(request, "fork", args));
  tool("artifact_site_share", "Create a share link", "Create a reader link for an existing remote artifact when the user wants to share a report or page. Choose public, signed-in, email-restricted or passcode access explicitly. A public link opens only that share URL; the original artifact visibility stays unchanged. Returns the new link and any generated passcode; keep these for the user because later listing returns only summaries. Requires owner permission. Use get_site include:[shares] to inspect existing sharing records.", { ...slug, mode: z.enum(["view","comment","edit"]).default("view").describe("Share role; edit requires sign-in and the latest version."), versionId: id.optional().describe("Pin a view/comment link to this version; omit for latest."), policy: policies.describe("Required access policy: public, login, people, or passcode; email is a compatibility alias."), label: z.string().optional().describe("Optional name to distinguish this link."), expiresInDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional().describe("Optional expiration in days."), passcode: z.string().optional().describe("Only for passcode policy; omitted means generate one.") }, async ({ slug, ...body }, request) => callApi(request, "share", { slug, body }));
  tool("artifact_site_rollback", "Roll back a site", "Restore an earlier remote artifact version as a new current version, keeping the address and history. Use when the user explicitly wants to undo a publication/update. Get version IDs with get_site include:[versions]. This changes current contents; establish the user's intended version before calling. Returns the new version identifier.", { ...slug, version_id: id.describe("Historical version to restore, from get_site with versions included.") }, async ({ slug, version_id }, request) => callApi(request, "rollback", { slug, body: { versionId: version_id } }));
  tool("artifact_site_delete", "Delete a site", "Move an existing remote artifact to the trash when the user explicitly asks to delete it. This removes it from normal access; it is not an upload cancellation or a way to hide a share link. Verify the intended artifact using find/get_site when ambiguous. Requires ownership or equivalent authorized privileges; returns deletion confirmation.", slug, async (args, request) => callApi(request, "delete", args));
  tool("artifact_site_export", "Export a site", "Download or back up a remote artifact's original files, including binary assets. Without path, returns a manifest, versionId and authenticated ZIP download URL. To retrieve everything using MCP alone, call again for each manifest path with version_id and offset; decode base64 and repeat nextOffset until done. No CLI is required. A 409 means the version changed: restart from a new manifest to avoid mixed versions. Requires original-content access, which may be stricter than text read access. Never put the Bearer token in a URL.", { ...slug, path: z.string().optional().describe("Relative file path from the export manifest; omit to get the manifest."), version_id: id.optional().describe("Required with path; pins the manifest's version."), offset: z.number().int().min(0).optional().describe("Byte offset for file download, initially 0."), length: z.number().int().min(1).max(CHUNK_BYTES).optional().describe("Bytes per download chunk, at most 262144.") }, async ({ slug, version_id, path, offset = 0, length = CHUNK_BYTES }, request) => {
    if (path !== undefined && !version_id) throw new BadRequestError("version_id is required with path");
    if (path === undefined && (version_id !== undefined || offset !== 0 || length !== CHUNK_BYTES)) throw new BadRequestError("Download parameters require path");
    const view = await getSiteView(slug); if (!view) throw Object.assign(new Error("site not found"), { statusCode: 404 });
    await requirePermission(apiRequest(request, `/api/sites/${slug}/export`), view.site, "site.source.export");
    if (path === undefined) return { slug, versionId: view.version.id, files: await getStorage().list(view.site.id, view.version.id), downloadUrl: new URL(`/api/sites/${encodeURIComponent(slug)}/export`, publicBase).href, authorization: "Send your configured Bearer token; it is not embedded in the URL." };
    if (view.version.id !== version_id) throw Object.assign(new Error("Version changed; export again"), { statusCode: 409 });
    const data = await getStorage().readRange(view.site.id, version_id, safeRelativePath(path), offset, offset + length - 1);
    return { versionId: version_id, path, offset, total: data.total, base64: Buffer.from(data.bytes).toString("base64"), nextOffset: offset + data.bytes.length, done: offset + data.bytes.length >= data.total };
  });
  tool("artifact_site_upload_start", "Start an upload", "Prepare a large document or multi-file website for remote publication when inline publish/update would exceed the 2 MiB MCP request limit. Returns versionId, used as upload_id in upload_write and publish/update. Omit slug for a new artifact; include it for whole-content replacement of that artifact. Send actual bytes using upload_write, never a path on your local machine. Check connection for deployment limits. Incomplete uploads expire after six hours.", { slug: id.optional().describe("Existing artifact to replace; omit when creating a new artifact."), title: z.string().max(500).optional().describe("Optional title for the completed artifact.") }, async (body, request) => callApi(request, "upload_start", { body }));
  tool("artifact_site_upload_write", "Write upload content", "Transfer one file's bytes into a remote upload. Use after upload_start; file creation and assembly are automatic. Send files and chunks sequentially, index starting at 0 for each relative path, at most 256 KiB decoded bytes per chunk. Set final:true on the last chunk of EVERY file (empty files use empty base64). Identical chunk retries are safe, including the final chunk; finalized files cannot be changed in this upload. After all files finish, use publish with upload_id or update with slug, upload_id and expected_version. Does not publish by itself.", { upload_id: id.describe("versionId returned by upload_start."), path: z.string().min(1).max(1024).describe("Relative uploaded filename, e.g. assets/chart.png; never an absolute local path."), index: z.number().int().min(0).describe("Zero-based sequential chunk index within this file."), base64: z.string().max(349528).describe("Base64-encoded bytes, at most 262144 decoded bytes."), final: z.boolean().describe("True only for the last chunk of this file.") }, async ({ upload_id, path, index, base64, final }, request) => writeFileChunk(request, upload_id, path, index, base64, final));
  tool("artifact_site_upload_cancel", "Cancel an upload", "Abandon an unfinished remote upload when the user cancels publication or wants to restart it. Invalidates the upload and reclaims staged project bytes and temporary chunk parts. Does not delete a published artifact. Supply the upload ID from upload_start.", { upload_id: id.describe("versionId returned by upload_start, not a published artifact slug.") }, async ({ upload_id }, request) => cancelUpload(request, upload_id));
  server.registerResource("skill", "artifact-site://skill", { mimeType: "text/markdown" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: getSkillForBase(publicBase) }] }));
  return server;
}
