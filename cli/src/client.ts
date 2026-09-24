import { DEFAULT_UPLOAD_LIMITS, type UploadLimits } from "./archive.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
// Typed client for the artifact-site HTTP API. One method per endpoint, no CLI or MCP concerns.
// The contract is the one documented for agents at /for-agents.md; response shapes are mirrored
// here as interfaces so both front ends type-check against the same thing.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

export type SiteKind = "single" | "folder" | "document";
export type SharePolicy = "public" | "login" | "people" | "email" | "passcode";

export interface CreatedSite {
  officialVersionId?: string | null; officialRevision?: number; versionId?: string;
  slug: string;
  url: string;
  title: string;
  kind: SiteKind;
  editToken?: string;
  notice?: string;
}

export interface VersionResult {
  officialVersionId?: string | null; officialRevision?: number;
  slug: string;
  url: string;
  title: string;
  kind: SiteKind;
  versionId: string;
}

export interface SiteInfo {
  slug: string;
  url: string;
  title: string;
  kind: SiteKind;
  site: Record<string, unknown> & { visibility?: string; updatedAt?: number; createdAt?: number };
  version: { id: string; createdAt?: number; source?: string; fileCount?: number };
  files: string[];
}

export interface SearchResult { relationship?: "owned" | "collaborating" | "anonymous" | "public"; slug: string; title: string; kind: SiteKind; visibility?: string; takenDownAt?: number | null; updatedAt?: number; url: string; snippet: string }
export interface SiteText { slug: string; url: string; title: string; kind: SiteKind; versionId: string; file: string | null; chars: number; truncated: boolean; text: string }

export interface VersionRow { id: string; createdAt: number; source?: string; fileCount?: number; bytes?: number }

export interface SiteRow { slug: string; title: string; kind: SiteKind; visibility?: string; updatedAt?: number; createdAt?: number }

export interface ShareResult {
  share: { id: string; policy: SharePolicy; label?: string | null; expiresAt?: number | null };
  token: string;
  url: string;
  passcode?: string;
}

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_url: string;
  verification_url_manual: string;
  user_message: string;
  interval: number;
  expires_in: number;
}

export type DevicePoll =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "approved"; token: string; user: { email?: string; id?: string } };

export interface Folder { id: string; name: string; createdAt: number }
export interface Me { operator?: boolean; uploadLimits?: UploadLimits; user: { id: string; email?: string; displayName?: string } | null; oidcEnabled: boolean }

/** An HTTP-level failure. `status` is the code, `message` the server's `{error}` text when it sent one. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: unknown = null) {
    super(message);
    this.name = "ApiError";
  }
  /** The server's machine-readable reason, when it sent one (`quota_exceeded`, `token_unknown`, `token_revoked`, …). */
  get code(): string | undefined {
    const b = this.body as { code?: unknown } | null;
    return typeof b?.code === "string" ? b.code : undefined;
  }
  /** The optimistic-lock conflict both write paths answer; carries the version that won. */
  get currentVersionId(): string | undefined {
    const b = this.body as { currentVersionId?: unknown } | null;
    return typeof b?.currentVersionId === "string" ? b.currentVersionId : undefined;
  }
}

export interface ClientOptions {
  tenantId?: string;
  shareToken?: string;
  baseUrl: string;
  token?: string | null;
  fetch?: typeof fetch;
  /** Retries after the first attempt: 429 for all methods, 5xx only for GET/PUT.
   * Retry-After is honored with a bounded backoff; unsafe writes need outcome recovery. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

type Query = Record<string, string | undefined>;

export class ArtifactSiteClient {
  readonly baseUrl: string;
  private readonly operation = new AsyncLocalStorage<string>();
  withOperation<T>(key: string, work: () => Promise<T>): Promise<T> { return this.operation.run(key, work); }
  /** Stable local namespace; credentials themselves never enter recovery records. */
  async recoveryIdentity(): Promise<string> {
    const user = (await this.publicationMe()).user;
    const principal = user?.id ?? `credential:${createHash("sha256").update(this.token ?? "").digest("hex")}`;
    return createHash("sha256").update(JSON.stringify([this.baseUrl, principal, this.tenantId, this.shareToken])).digest("hex");
  }
  operationStatus(key: string): Promise<{ status: "completed" | "running" | "retryable"; result?: VersionResult; expiresAt: number }> { return this.json("GET", `/api/operations/${enc(key)}`); }
  uploadStatus(versionId: string): Promise<{ files: { relpath: string; bytes: number; sha256?: string }[]; expiresAt: number }> { return this.json("GET", `/api/uploads/${enc(versionId)}`); }

  private readonly token: string | null;
  private tenantId?: string;
  private shareToken?: string;
  private anonCookie: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: ClientOptions) {
    this.tenantId = opts.tenantId;
    this.shareToken = opts.shareToken;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token ?? null;
    this.fetchImpl = opts.fetch ?? fetch;
    this.retries = opts.retries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  setContext(context: {tenantId?:string;shareToken?:string}): this {
    if (this.tenantId !== context.tenantId || this.shareToken !== context.shareToken) this.meOnce = undefined;
    this.tenantId = context.tenantId; this.shareToken = context.shareToken; return this;
  }

  get authenticated(): boolean { return Boolean(this.token); }

  /** Absolute URL for a site-relative path the API returned (`/s/...`, `/v/...`). */
  absolute(pathOrUrl: string): string {
    return /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${this.baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
  }

  // ---- identity ------------------------------------------------------------------------------

  deviceStart(): Promise<DeviceStart> { return this.json("POST", "/api/device/start"); }
  devicePoll(deviceCode: string): Promise<DevicePoll> { return this.json("POST", "/api/device/poll", { body: { device_code: deviceCode } }); }
  async uploadLimits(): Promise<UploadLimits> {
    const limits = (await this.publicationMe()).uploadLimits;
    if (!limits) return DEFAULT_UPLOAD_LIMITS; // Older servers do not advertise limits.
    if (![limits.maxBytes, limits.maxFileBytes, limits.maxFiles].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error("Server returned invalid upload limits");
    return limits;
  }
  // A CLI client shares one snapshot across publication preflights, including concurrent calls.
  // Keep explicit me() checks live, and never retain a failed lookup.
  private meOnce?: Promise<Me>;
  private publicationMe(): Promise<Me> {
    if (!this.meOnce) {
      const pending = this.me().catch(error => {
        if (this.meOnce === pending) this.meOnce = undefined;
        throw error;
      });
      this.meOnce = pending;
    }
    return this.meOnce;
  }
  me(): Promise<Me> { return this.json("GET", "/api/auth/me"); }

  // ---- sites ---------------------------------------------------------------------------------

  createPaste(html: string, title?: string, official?: boolean): Promise<CreatedSite> {
    return this.json("POST", "/api/sites", { body: { mode: "paste", html, title, official } });
  }
  /** One-shot upload of a single file (HTML or a document) — byte-clean via multipart. */
  createFile(filename: string, bytes: Uint8Array, title?: string, official?: boolean): Promise<CreatedSite> {
    return this.json("POST", "/api/sites", { form: withOfficial(withTitle(multipart("file", filename, bytes), title), official) });
  }
  createZip(bytes: Uint8Array, title?: string, official?: boolean): Promise<CreatedSite> {
    return this.json("POST", "/api/sites", { form: withOfficial(withTitle(multipart("zip", "site.zip", bytes), title), official) });
  }
  getOfficial(slug: string): Promise<{ officialVersionId: string | null; officialRevision?: number }> { return this.json("GET", `/api/sites/${enc(slug)}/official`); }
  setOfficial(slug: string, versionId: string | null, expectedRevision?: number): Promise<{ officialVersionId: string | null; previousOfficialVersionId: string | null }> { return this.json(versionId ? "PUT" : "DELETE", `/api/sites/${enc(slug)}/official`, { body: { versionId: versionId ?? undefined, expectedRevision } }); }
  getSite(slug: string): Promise<SiteInfo> { return this.json("GET", `/api/sites/${enc(slug)}`); }
  listVersions(slug: string): Promise<{ versions: VersionRow[]; currentVersionId: string }> {
    return this.json("GET", `/api/sites/${enc(slug)}/versions`);
  }
  publicSites(): Promise<{ sites: SiteRow[] }> { return this.json("GET", "/api/sites"); }
  listFolders(): Promise<{ folders: Folder[]; assign: Record<string, string> }> { return this.json("GET", "/api/me/folders"); }
  moveToFolder(slug: string, folderId: string | null): Promise<{ ok: true; slug: string; folderId: string | null }> {
    return this.json("PUT", "/api/me/folders/assignments", { body: { slug, folderId } });
  }
  mySites(): Promise<{ owned: SiteRow[]; collaborating: SiteRow[] }> { return this.json("GET", "/api/me/sites"); }
  rename(slug: string, title: string): Promise<{ slug: string; title: string }> {
    return this.json("PATCH", `/api/sites/${enc(slug)}`, { body: { title } });
  }
  delete(slug: string): Promise<{ deleted: true; slug: string }> { return this.json("DELETE", `/api/sites/${enc(slug)}`); }
  rollback(slug: string, versionId: string): Promise<VersionResult> {
    return this.json("POST", `/api/sites/${enc(slug)}/rollback`, { body: { versionId } });
  }
  fork(slug: string): Promise<CreatedSite> { return this.json("POST", `/api/sites/${enc(slug)}/fork`); }

  // ---- changing content ---------------------------------------------------------------------

  /** kind=single: `content` replaces the page; kind=folder: `path` + `content` replaces one file. */
  edit(slug: string, change: { content: string; path?: string }, expectedVersion?: string): Promise<VersionResult> {
    return this.json("POST", `/api/sites/${enc(slug)}/edit`, { body: change, query: { expected_version: expectedVersion } });
  }
  /** Whole-tree replacement for a folder site (zip) — or the new file of a document site. */
  replaceWithZip(slug: string, bytes: Uint8Array, expectedVersion?: string, official?: boolean): Promise<VersionResult> {
    return this.json("POST", `/api/sites/${enc(slug)}/versions`, { form: withOfficial(multipart("zip", "site.zip", bytes), official), query: { expected_version: expectedVersion } });
  }
  replaceWithFile(slug: string, filename: string, bytes: Uint8Array, expectedVersion?: string, official?: boolean): Promise<VersionResult> {
    return this.json("POST", `/api/sites/${enc(slug)}/versions`, { form: withOfficial(multipart("file", filename, bytes), official), query: { expected_version: expectedVersion } });
  }
  /** The current version as a zip, plus the version id to pass back as `expected_version`. */
  async export(slug: string, versionId?: string): Promise<{ zip: Uint8Array; versionId: string | null }> {
    const res = await this.request("GET", `/api/sites/${enc(slug)}/export`, {query:{version_id:versionId}});
    return { zip: new Uint8Array(await res.arrayBuffer()), versionId: res.headers.get("x-artifact-version") };
  }

  // ---- chunked upload (large trees, large PDFs) ----------------------------------------------

  openUpload(opts: { title?: string; slug?: string } = {}): Promise<{ versionId: string }> {
    return this.json("POST", "/api/uploads", { body: opts });
  }
  /** Streams one file from disk; nothing is buffered on either side. */
  async uploadFile(versionId: string, relpath: string, filePath: string): Promise<{ relpath: string; bytes: number }> {
    const size = (await stat(filePath)).size;
    const res = await this.withRetry(() => {
      const body = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream;
      return this.fetchImpl(this.url(`/api/uploads/${enc(versionId)}/files/${relpath.split("/").map(encodeURIComponent).join("/")}`), {
        method: "PUT", headers: { ...this.authHeaders(), "content-type": "application/octet-stream", "content-length": String(size) },
        body, duplex: "half",
      } as RequestInit & { duplex: "half" });
    }, true);
    return this.parse(res);
  }
  uploadBytes(versionId: string, relpath: string, bytes: Uint8Array): Promise<{ relpath: string; bytes: number }> {
    return this.json("PUT", `/api/uploads/${enc(versionId)}/files/${relpath.split("/").map(encodeURIComponent).join("/")}`, { raw: bytes });
  }
  commitUpload(versionId: string, title?: string, expectedVersion?: string, official?: boolean): Promise<VersionResult & { editToken?: string }> {
    return this.json("POST", `/api/uploads/${enc(versionId)}/commit`, { body: { ...(title ? { title } : {}), ...(official === undefined ? {} : { official }) }, query: { expected_version: expectedVersion } });
  }

  // ---- sharing -------------------------------------------------------------------------------

  createShare(slug: string, opts: { source?: "publish" | "manual"; mode?: "view" | "comment" | "edit"; versionId?: string; policy: SharePolicy; label?: string; expiresInDays?: number; passcode?: string; allowAi?: boolean }): Promise<ShareResult> {
    return this.json("POST", `/api/sites/${enc(slug)}/shares`, { body: opts });
  }
  listShares(slug: string): Promise<{ shares: ShareResult["share"][] }> { return this.json("GET", `/api/sites/${enc(slug)}/shares`); }

  // ---- finding and reading ----------------------------------------------------------------------

  /** Sites whose current text contains every word, best first; what the caller may list is what is searched. */
  search(query: string, limit?: number): Promise<{ query: string; results: SearchResult[] }> {
    return this.json("GET", "/api/search", { query: { q: query, limit: limit === undefined ? undefined : String(limit) } });
  }
  /** The current version as plain text, or one file of the tree verbatim (`file`). */
  readText(slug: string, opts: { file?: string; maxChars?: number; versionId?: string } = {}): Promise<SiteText> {
    return this.json("GET", `/api/sites/${enc(slug)}/text`, { query: { version_id:opts.versionId, file: opts.file, max_chars: opts.maxChars === undefined ? undefined : String(opts.maxChars) } });
  }

  listComments(slug: string, opts: {versionId?: string; shareId?: string; aggregate?: boolean; allVersions?: boolean; status?: string; cursor?: string; limit?: number} = {}): Promise<Record<string, unknown>> {
    return this.json("GET", `/api/sites/${enc(slug)}/comments/agent-list`, {query: {versionId:opts.versionId,shareId:opts.shareId,aggregate:opts.aggregate ? "true" : undefined,allVersions:opts.allVersions ? "true" : undefined,status:opts.status,cursor:opts.cursor,limit:opts.limit === undefined ? undefined : String(opts.limit)}});
  }
  readComment(slug: string, threadId: string, cursor?: string, limit?: number): Promise<Record<string, unknown>> {
    return this.json("GET", `/api/sites/${enc(slug)}/comments/${enc(threadId)}${cursor ? "/messages" : ""}`, {query: cursor ? {cursor,limit:limit === undefined ? undefined : String(limit)} : undefined});
  }
  commentContext(slug: string, threadId: string): Promise<Record<string, unknown>> {
    return this.json("GET", `/api/sites/${enc(slug)}/comments/${enc(threadId)}/agent-context`);
  }

  /** The agent skill as this deployment serves it (base URL already rewritten). */
  async skill(): Promise<string> {
    const res = await this.request("GET", "/for-agents.md");
    return res.text();
  }

  // ---- plumbing ------------------------------------------------------------------------------

  private url(path: string, query?: Query): string {
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") u.searchParams.set(k, v);
    return u.toString();
  }

  private authHeaders(): Record<string, string> {
    // `Origin` is what the server's CSRF gate compares against ARTIFACT_PUBLIC_URL for callers it
    // treats as ambient (cookies, the admin token). Sending it always costs nothing and means every
    // credential form passes the gate the same way a browser tab would.
    return { ...(this.tenantId ? {"x-artifact-tenant":this.tenantId} : {}), ...(this.shareToken ? {"x-artifact-share":this.shareToken} : {}), origin: new URL(this.baseUrl).origin, ...(this.anonCookie ? { cookie: this.anonCookie } : {}), ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) };
  }

  private async request(method: string, path: string, opts: { body?: unknown; form?: FormData; raw?: Uint8Array; query?: Query } = {}): Promise<Response> {
    const headers: Record<string, string> = { ...this.authHeaders() };
    const key = this.operation.getStore();
    if (key && method === "POST") headers["idempotency-key"] = key;
    let body: BodyInit | undefined;
    if (opts.form) body = opts.form;
    else if (opts.raw) { headers["content-type"] = "application/octet-stream"; body = new Blob([opts.raw as BlobPart]); }
    else if (opts.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(opts.body); }
    const res = await this.withRetry(() => this.fetchImpl(this.url(path, opts.query), { method, headers, body }), method === "GET" || method === "PUT");
    if (!res.ok) throw await this.toError(res);
    return res;
  }

  private async json<T>(method: string, path: string, opts: { body?: unknown; form?: FormData; raw?: Uint8Array; query?: Query } = {}): Promise<T> {
    return this.parse<T>(await this.request(method, path, opts));
  }

  private async parse<T>(res: Response): Promise<T> {
    if (!res.ok) throw await this.toError(res);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async toError(res: Response): Promise<ApiError> {
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    const message = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : res.status === 413 && !body ? "The request body was refused (413); check the gateway limit or use file uploads. The response did not confirm whether the application ran" : `HTTP ${res.status}`;
    return new ApiError(res.status, message, body);
  }

  /** Only replay safe methods on 5xx; rebuilding a stream is the caller's responsibility. */
  private async withRetry(run: () => Promise<Response>, safe = false): Promise<Response> {
    let attempt = 0;
    for (;;) {
      const res = await run();
      // Operator-token and anonymous uploads are bound to the server-issued browser identity.
      // Keep only that cookie, in memory, for subsequent requests to this deployment.
      for (const cookie of res.headers.getSetCookie()) {
        const pair = cookie.split(";", 1)[0];
        if (/^(?:__Host-)?ah_anon=/.test(pair)) this.anonCookie = pair;
      }
      const retryable = res.status === 429 || (safe && res.status >= 500);
      if (!retryable || attempt >= this.retries) return res;
      await res.body?.cancel().catch(() => {});
      attempt += 1;
      const retryAfter = res.headers.get("retry-after");
      const delay = retryAfter ? Number(retryAfter) * 1000 || Date.parse(retryAfter) - Date.now() : 0;
      await this.sleep(Math.min(60_000, Math.max(delay || 0, Math.min(8000, 500 * 2 ** attempt))));
    }
  }
}

function enc(s: string): string { return encodeURIComponent(s); }

function multipart(mode: string, filename: string, bytes: Uint8Array): FormData {
  const form = new FormData();
  form.set("mode", mode);
  form.set("file", new Blob([bytes as BlobPart]), filename);
  return form;
}

function withTitle(form: FormData, title?: string): FormData {
  if (title) form.set("title", title);
  return form;
}

function withOfficial(form: FormData, official?: boolean): FormData { if (official !== undefined) form.set("official", String(official)); return form; }
