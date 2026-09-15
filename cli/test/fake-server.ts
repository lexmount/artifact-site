// An in-memory artifact-site that speaks the same contract as the real API (as documented in
// /for-agents.md and mirrored in src/client.ts). Enough behaviour to prove the CLI and the MCP
// server drive every route correctly: modes, chunked upload, optimistic locking, shares, device
// sign-in, rate limiting, and the error shapes. Not a reimplementation of the product.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { unzipSync, zipSync } from "fflate";

interface Version { id: string; createdAt: number; source: string; files: Record<string, Uint8Array> }
interface Site { officialVersionId?: string | null; officialRevision?: number; slug: string; title: string; kind: "single" | "folder" | "document"; visibility: string; owner: string | null; versions: Version[]; deleted?: boolean }
interface UploadSession { versionId: string; slug?: string; title?: string; files: Record<string, Uint8Array>; owner: string | null }

export interface FakeServer {
  url: string;
  close(): Promise<void>;
  state: {
    sites: Map<string, Site>;
    tokens: Map<string, { email: string; id: string }>;
    grants: Map<string, { status: "pending" | "approved" | "consumed" | "expired"; token?: string; email?: string }>;
    uploads: Map<string, UploadSession>;
    shares: { slug: string; token: string; policy: string; passcode?: string }[];
    requests: { method: string; path: string; auth: string | null }[];
    /** Answer the next N requests with 429 (to exercise the client's retry). */
    rateLimitNext: number;
    /** Auto-approve device grants after this many polls. */
    approveAfterPolls: number;
  };
  /** Mint a token for a user (what a completed device flow would have produced). */
  token(email?: string): string;
}

let seq = 0;
const id = (p: string) => `${p}_${(++seq).toString(36).padStart(6, "0")}`;
const slugOf = () => Math.random().toString(36).slice(2, 14);

export async function startFakeServer(): Promise<FakeServer> {
  const state: FakeServer["state"] = { sites: new Map(), tokens: new Map(), grants: new Map(), uploads: new Map(), shares: [], requests: [], rateLimitNext: 0, approveAfterPolls: 1 };
  const polls = new Map<string, number>();

  const server: Server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      send(res, 500, { error: (e as Error).message });
    }
  });

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    if (body instanceof Uint8Array) { res.writeHead(status, { "content-type": "application/zip", ...headers }); res.end(Buffer.from(body)); return; }
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  function auth(req: IncomingMessage): { id: string; email: string } | null {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) return null;
    return state.tokens.get(h.slice(7)) ?? null;
  }

  async function toRequest(req: IncomingMessage, url: URL): Promise<Request> {
    return new Request(url, { method: req.method, headers: req.headers as Record<string, string>, body: req.method === "GET" || req.method === "HEAD" ? undefined : (Readable.toWeb(req) as unknown as ReadableStream), duplex: "half" } as RequestInit);
  }

  function kindOf(files: Record<string, Uint8Array>): Site["kind"] {
    const names = Object.keys(files);
    if (names.length === 1 && /\.(pdf|pptx?|docx?)$/i.test(names[0])) return "document";
    if (names.length === 1 && names[0].endsWith(".html")) return "single";
    return "folder";
  }

  function assertSafe(files: Record<string, Uint8Array>): string | null {
    for (const name of Object.keys(files)) {
      if (/(^|\/)(node_modules|\.git)(\/|$)/i.test(name)) return `unsafe path: ${name}`;
      if (name.split("/").some((seg) => seg.startsWith("."))) return `unsafe path: ${name}`;
    }
    const kind = kindOf(files);
    if (kind === "folder" && !("index.html" in files) && !Object.keys(files).some((n) => n.endsWith(".html"))) return "No HTML file found";
    return null;
  }

  async function readUpload(request: Request): Promise<{ files: Record<string, Uint8Array>; title?: string; official?: boolean } | { error: string }> {
    const ct = request.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const body = (await request.json()) as Record<string, unknown>;
      const official = body.official === true;
      const title = typeof body.title === "string" ? body.title : undefined;
      if (body.mode === "paste") return { files: { "index.html": new TextEncoder().encode(String(body.html)) }, title, official };
      if (body.mode === "file") return { files: { [String(body.filename)]: body.content !== undefined ? new TextEncoder().encode(String(body.content)) : new Uint8Array(Buffer.from(String(body.base64), "base64")) }, title, official };
      if (body.mode === "folder") return { files: Object.fromEntries((body.files as { path: string; content: string }[]).map((f) => [f.path, new TextEncoder().encode(f.content)])), title, official };
      if (body.mode === "zip") return { files: unzipSafe(new Uint8Array(Buffer.from(String(body.base64), "base64"))) ?? {}, title, official };
      return { error: `Unknown or missing mode: ${String(body.mode ?? "(none)")}` };
    }
    if (ct.includes("multipart/form-data")) {
      const form = await request.formData();
      const mode = form.get("mode");
      const official = form.get("official") === "true";
      const title = (form.get("title") as string | null) ?? undefined;
      const file = form.get("file");
      if (mode === "file" && file instanceof File) return { files: { [file.name]: new Uint8Array(await file.arrayBuffer()) }, title, official };
      if (mode === "zip" && file instanceof File) {
        const files = unzipSafe(new Uint8Array(await file.arrayBuffer()));
        return files ? { files, title, official } : { error: "Not a valid zip archive" };
      }
      return { error: `Unknown or missing mode: ${String(mode ?? "(none)")}` };
    }
    return { error: "unsupported content-type" };
  }

  function unzipSafe(bytes: Uint8Array): Record<string, Uint8Array> | null {
    try {
      const out = unzipSync(bytes);
      const files: Record<string, Uint8Array> = {};
      for (const [name, data] of Object.entries(out)) if (!name.endsWith("/")) files[name] = data;
      // flatten a single wrapper directory, like the platform
      const tops = new Set(Object.keys(files).map((n) => n.split("/")[0]));
      if (tops.size === 1 && Object.keys(files).every((n) => n.includes("/"))) {
        const prefix = [...tops][0] + "/";
        return Object.fromEntries(Object.entries(files).map(([n, d]) => [n.slice(prefix.length), d]));
      }
      return files;
    } catch { return null; }
  }

  function siteJson(site: Site) {
    return { officialVersionId: site.officialVersionId ?? null, officialRevision: site.officialRevision ?? 0, slug: site.slug, url: `/s/${site.slug}`, title: site.title, kind: site.kind };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const method = req.method ?? "GET";
    state.requests.push({ method, path: url.pathname, auth: req.headers.authorization ?? null });
    if (state.rateLimitNext > 0) { state.rateLimitNext -= 1; req.resume(); return send(res, 429, { error: "rate limited" }); }
    const user = auth(req);
    const p = url.pathname;

    if (method === "GET" && p === "/for-agents.md") { res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }); res.end(`# Publishing artifacts\n\n**Base URL**: http://${req.headers.host}\n`); return; }
    if (method === "GET" && p === "/api/auth/me") {
      // Mirrors the real server: a presented Bearer this server does not know is refused with a reason.
      if (req.headers.authorization?.startsWith("Bearer ") && !user) return send(res, 401, { error: "This server does not know this publish token", code: "token_unknown" });
      return send(res, 200, { user: user ? { id: user.id, email: user.email } : null, oidcEnabled: true });
    }

    if (method === "POST" && p === "/api/device/start") {
      const code = id("dev"); state.grants.set(code, { status: "pending" }); polls.set(code, 0);
      return send(res, 200, { device_code: code, user_code: "ABCD-EFGH", verification_url: `${url.origin}/activate?code=ABCD-EFGH`, verification_url_manual: `${url.origin}/activate`, user_message: "Open http://x/activate and enter ABCD-EFGH", interval: 1, expires_in: 600 });
    }
    if (method === "POST" && p === "/api/device/poll") {
      const body = (await (await toRequest(req, url)).json()) as { device_code?: string };
      const g = body.device_code ? state.grants.get(body.device_code) : undefined;
      if (!g) return send(res, 400, { error: "Invalid device_code" });
      if (g.status === "consumed") return send(res, 400, { error: "This authorization has already been redeemed" });
      if (g.status === "expired") return send(res, 200, { status: "expired" });
      const n = (polls.get(body.device_code!) ?? 0) + 1; polls.set(body.device_code!, n);
      if (g.status === "pending" && n < state.approveAfterPolls) return send(res, 200, { status: "pending" });
      const token = fake.token("dev@example.com"); g.status = "consumed"; g.token = token;
      return send(res, 200, { status: "approved", token, user: { email: "dev@example.com" } });
    }

    if (method === "GET" && p === "/api/search") {
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      if (!q) return send(res, 400, { error: "q is required" });
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const words = q.split(/\s+/);
      const results = [...state.sites.values()]
        .filter((s) => !s.deleted && (s.visibility === "public" || s.owner === (user?.id ?? null)))
        .map((s) => ({ s, text: Object.values(s.versions.at(-1)!.files).map((b) => new TextDecoder().decode(b).replace(/<[^>]+>/g, " ")).join(" ") }))
        .filter(({ s, text }) => words.every((w) => `${s.title} ${text}`.toLowerCase().includes(w)))
        .slice(0, limit)
        .map(({ s, text }) => ({ slug: s.slug, title: s.title, kind: s.kind, visibility: s.visibility, url: `/s/${s.slug}`, snippet: text.replace(/\s+/g, " ").trim().slice(0, 100) }));
      return send(res, 200, { query: q, results });
    }

    if (method === "GET" && p === "/api/me/sites") {
      if (!user) return send(res, 401, { error: "Please sign in first" });
      const owned = [...state.sites.values()].filter((s) => !s.deleted && s.owner === user.id).map((s) => ({ slug: s.slug, title: s.title, kind: s.kind, visibility: s.visibility }));
      return send(res, 200, { owned, collaborating: [] });
    }

    if (method === "POST" && p === "/api/sites") {
      const r = await readUpload(await toRequest(req, url));
      if ("error" in r) return send(res, 400, { error: r.error });
      const bad = assertSafe(r.files); if (bad) return send(res, 400, { error: bad });
      const site: Site = { slug: slugOf(), title: r.title ?? Object.keys(r.files)[0].replace(/\.[^.]+$/, ""), kind: kindOf(r.files), visibility: "private", owner: user?.id ?? null, versions: [{ id: id("ver"), createdAt: Date.now(), source: "upload", files: r.files }] };
      if (r.official) { site.officialVersionId = site.versions.at(-1)!.id; site.officialRevision = 1; }
      state.sites.set(site.slug, site);
      return send(res, 200, { ...siteJson(site), editToken: "edit-" + site.slug, claimToken: user ? undefined : "claim-" + site.slug, notice: user ? undefined : "Anonymous publish: bind an identity next time" });
    }

    // chunked upload
    if (method === "POST" && p === "/api/uploads") {
      const body = (await (await toRequest(req, url)).json().catch(() => ({}))) as { slug?: string; title?: string };
      if (body.slug && !state.sites.get(body.slug)) return send(res, 404, { error: "site not found" });
      const s: UploadSession = { versionId: id("ver"), slug: body.slug, title: body.title, files: {}, owner: user?.id ?? null };
      state.uploads.set(s.versionId, s);
      return send(res, 201, { versionId: s.versionId });
    }
    let m = p.match(/^\/api\/uploads\/([^/]+)\/files\/(.+)$/);
    if (method === "PUT" && m) {
      const s = state.uploads.get(m[1]);
      if (!s || s.owner !== (user?.id ?? null)) { req.resume(); return send(res, 404, { error: "The upload session does not exist or has expired; please start again" }); }
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const relpath = m[2].split("/").map(decodeURIComponent).join("/");
      s.files[relpath] = new Uint8Array(Buffer.concat(chunks));
      return send(res, 200, { relpath, bytes: s.files[relpath].byteLength });
    }
    m = p.match(/^\/api\/uploads\/([^/]+)\/commit$/);
    if (method === "POST" && m) {
      const s = state.uploads.get(m[1]);
      if (!s) return send(res, 404, { error: "The upload session does not exist or has expired; please start again" });
      if (!Object.keys(s.files).length) return send(res, 400, { error: "No files have been uploaded yet" });
      const bad = assertSafe(s.files); if (bad) return send(res, 400, { error: bad });
      const body = (await (await toRequest(req, url)).json().catch(() => ({}))) as { title?: string };
      const version: Version = { id: s.versionId, createdAt: Date.now(), source: "upload", files: s.files };
      let site = s.slug ? state.sites.get(s.slug)! : undefined;
      if (site) { site.versions.push(version); }
      else { site = { slug: slugOf(), title: body.title ?? s.title ?? "Untitled site", kind: kindOf(s.files), visibility: "private", owner: user?.id ?? null, versions: [version] }; state.sites.set(site.slug, site); }
      if (body.official) { site.officialVersionId = version.id; site.officialRevision = (site.officialRevision ?? 0) + 1; }
      state.uploads.delete(s.versionId);
      return send(res, 201, { ...siteJson(site), versionId: version.id, editToken: "edit-" + site.slug });
    }

    m = p.match(/^\/api\/sites\/([^/]+)(?:\/(.*))?$/);
    if (!m) return send(res, 404, { error: "not found" });
    const site = state.sites.get(m[1]);
    if (!site || site.deleted) return send(res, 404, { error: "site not found" });
    const sub = m[2] ?? "";
    const current = () => site.versions[site.versions.length - 1];
    const mayEdit = () => Boolean(user && (site.owner === user.id || site.owner === null));
    const locked = (): ServerResponse | null => {
      const expected = url.searchParams.get("expected_version");
      if (expected && expected !== current().id) { send(res, 409, { error: "version_conflict", currentVersionId: current().id }); return res; }
      return null;
    };

    if (sub === "official") {
      if (method === "GET") return send(res, 200, { officialVersionId: site.officialVersionId ?? null, officialRevision: site.officialRevision ?? 0 });
      if (!mayEdit()) return send(res, 403, { error: "forbidden" });
      const body = await (await toRequest(req, url)).json() as { versionId?: string; expectedRevision?: number };
      if (body.expectedRevision !== undefined && body.expectedRevision !== (site.officialRevision ?? 0)) return send(res, 409, { error: "stale" });
      if (method === "PUT" && !site.versions.some(v => v.id === body.versionId)) return send(res, 404, { error: "version not found" });
      const previousOfficialVersionId = site.officialVersionId ?? null;
      site.officialVersionId = method === "DELETE" ? null : body.versionId;
      site.officialRevision = (site.officialRevision ?? 0) + 1;
      return send(res, 200, { officialVersionId: site.officialVersionId, previousOfficialVersionId });
    }
    if (sub === "" && method === "GET") return send(res, 200, { ...siteJson(site), site: { slug: site.slug, title: site.title, kind: site.kind, visibility: site.visibility }, version: { id: current().id, createdAt: current().createdAt, source: current().source, fileCount: Object.keys(current().files).length }, files: Object.keys(current().files), file: "index.html", content: "" });
    if (sub === "" && method === "PATCH") { if (!mayEdit()) return send(res, 403, { error: "forbidden" }); const b = (await (await toRequest(req, url)).json()) as { title: string }; site.title = b.title; return send(res, 200, { slug: site.slug, title: site.title }); }
    if (sub === "" && method === "DELETE") { if (!mayEdit()) return send(res, 403, { error: "forbidden" }); site.deleted = true; return send(res, 200, { deleted: true, slug: site.slug }); }
    if (sub === "text" && method === "GET") {
      const file = url.searchParams.get("file");
      const max = Number(url.searchParams.get("max_chars") ?? 20000);
      let text: string;
      if (file !== null) {
        if (!(file in current().files)) return send(res, 404, { error: `file not found: ${file}` });
        if (!/\.(html?|css|js|json|md|txt|svg|xml)$/i.test(file)) return send(res, 415, { error: "not a text file; download it from the site instead", code: "not_text" });
        text = new TextDecoder().decode(current().files[file]);
      } else {
        text = Object.entries(current().files).filter(([n]) => /\.html?$/i.test(n)).map(([, b]) => new TextDecoder().decode(b).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).join("\n");
      }
      return send(res, 200, { slug: site.slug, url: `/s/${site.slug}`, title: site.title, kind: site.kind, versionId: current().id, file, chars: text.length, truncated: text.length > max, text: text.slice(0, max) });
    }
    if (sub === "versions" && method === "GET") return send(res, 200, { versions: site.versions.map((v) => ({ id: v.id, createdAt: v.createdAt, source: v.source, fileCount: Object.keys(v.files).length })), currentVersionId: current().id });
    if (sub === "export" && method === "GET") { if (!mayEdit()) return send(res, 403, { error: "forbidden" }); return send(res, 200, zipSync(current().files), { "x-artifact-version": current().id }); }
    if (sub === "edit" && method === "POST") {
      if (!mayEdit()) return send(res, 403, { error: "forbidden" });
      if (site.kind === "document") return send(res, 400, { error: "document sites are updated by re-uploading the file" });
      if (locked()) return;
      const b = (await (await toRequest(req, url)).json()) as { content: string; path?: string };
      const files = { ...current().files };
      if (site.kind === "single") { if (b.path) return send(res, 400, { error: "single-page sites take content only" }); files[Object.keys(files)[0]] = new TextEncoder().encode(b.content); }
      else { if (!b.path) return send(res, 400, { error: "folder sites need a path" }); files[b.path] = new TextEncoder().encode(b.content); }
      const v: Version = { id: id("ver"), createdAt: Date.now(), source: "edit", files }; site.versions.push(v);
      return send(res, 200, { ...siteJson(site), versionId: v.id });
    }
    if (sub === "versions" && method === "POST") {
      if (!mayEdit()) return send(res, 403, { error: "forbidden" });
      if (locked()) return;
      const r = await readUpload(await toRequest(req, url));
      if ("error" in r) return send(res, 400, { error: r.error });
      const shape = kindOf(r.files);
      if (site.kind === "document" ? shape !== "document" : shape === "document") return send(res, 400, { error: "the shape does not match the site's kind" });
      const v: Version = { id: id("ver"), createdAt: Date.now(), source: "upload", files: r.files }; site.versions.push(v);
      if (r.official) { site.officialVersionId = v.id; site.officialRevision = (site.officialRevision ?? 0) + 1; }
      return send(res, 200, { ...siteJson(site), versionId: v.id });
    }
    if (sub === "rollback" && method === "POST") {
      if (!mayEdit()) return send(res, 403, { error: "forbidden" });
      const b = (await (await toRequest(req, url)).json()) as { versionId: string };
      const target = site.versions.find((v) => v.id === b.versionId);
      if (!target) return send(res, 404, { error: "site or version not found" });
      const v: Version = { id: id("ver"), createdAt: Date.now(), source: "rollback", files: target.files }; site.versions.push(v);
      return send(res, 200, { ...siteJson(site), versionId: v.id });
    }
    if (sub === "fork" && method === "POST") {
      const copy: Site = { ...site, slug: slugOf(), title: `${site.title} (copy)`, owner: user?.id ?? null, versions: [{ ...current(), id: id("ver") }] };
      state.sites.set(copy.slug, copy);
      return send(res, 200, { ...siteJson(copy), editToken: "edit-" + copy.slug });
    }
    if (sub === "shares" && method === "POST") {
      if (!mayEdit()) return send(res, 403, { error: "forbidden" });
      const b = (await (await toRequest(req, url)).json().catch(() => ({}))) as { policy?: string; passcode?: string; label?: string; expiresInDays?: number };
      const policy = b.policy ?? "login";
      if (!["public", "login", "email", "passcode"].includes(policy)) return send(res, 400, { error: "policy must be one of public / login / email / passcode" });
      if (b.passcode && policy !== "passcode") return send(res, 400, { error: "A passcode only applies to links with policy=passcode" });
      const token = id("shr"); const passcode = policy === "passcode" ? b.passcode ?? "123456" : undefined;
      state.shares.push({ slug: site.slug, token, policy, passcode });
      return send(res, 201, { share: { id: id("share"), policy, label: b.label ?? null, expiresAt: b.expiresInDays ? Date.now() + b.expiresInDays * 86400000 : null }, token, url: `${url.origin}/v/${token}`, passcode: b.passcode ? undefined : passcode });
    }
    if (sub === "shares" && method === "GET") return send(res, 200, { shares: state.shares.filter((s) => s.slug === site.slug).map((s) => ({ id: s.token, policy: s.policy })) });
    return send(res, 404, { error: "not found" });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  const fake: FakeServer = {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    state,
    token(email = "user@example.com") { const t = "ahp_" + id("tok"); state.tokens.set(t, { email, id: "usr_" + email }); return t; },
  };
  return fake;
}
