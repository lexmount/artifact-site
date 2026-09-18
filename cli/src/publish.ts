import { tmpdir } from "node:os";
import { recovery } from "./recovery.js";
// The two operations agents and humans actually want — "put this online" and "replace what is
// online with this" — expressed once, on top of the client. Both pick the API route from the
// local shape and (for updates) the site's kind, so callers never have to know about modes.
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { ApiError, ArtifactSiteClient, type CreatedSite, type SharePolicy, type ShareResult, type SiteKind, type VersionResult } from "./client.js";
import { inspect, oneShotLimit, skippedLastWalk, zipFiles, preflightTree, extractZip, type WalkedFile, type LocalShape } from "./archive.js";

export interface PublishOptions {
  operationKey?: string;
  official?: boolean;
  title?: string;
  /** Create a share link right away. Default: `public` — a freshly created site is private on
   *  most deployments, so without a share the address is useless to anyone but the owner. */
  share?: SharePolicy | false;
  /** Progress lines for humans; silent by default. */
  onProgress?: (line: string) => void;
}

export interface PublishOutcome {
  site: CreatedSite | VersionResult;
  /** Absolute URL of the site itself (owner-visible). */
  siteUrl: string;
  share?: ShareResult;
  /** Set when a share was requested but could not be created — the site still exists. */
  shareError?: string;
  /** The address to hand to readers: the share URL when one was created, else the site URL. */
  readerUrl: string;
  route: "paste" | "file" | "zip" | "chunked";
}

export async function publishPath(client: ArtifactSiteClient, target: string, opts: PublishOptions = {}): Promise<PublishOutcome> {
  const shape = await inspect(target);
  const site = await createFromShape(client, shape, opts);
  return finish(client, site.result, site.route, opts);
}

export async function publishHtml(client: ArtifactSiteClient, html: string, opts: PublishOptions = {}): Promise<PublishOutcome> {
  const dir = await mkdtemp(path.join(tmpdir(), "artifact-html-"));
  const file = path.join(dir, "index.html");
  try {
    await writeFile(file, html, { mode: 0o600 });
    const files = [{ relpath: "index.html", absPath: file, size: Buffer.byteLength(html) }];
    const result = await uploadWithRecovery(client, files, opts, files[0].size > oneShotLimit() ? undefined : () => client.createPaste(html, opts.title, opts.official), "paste");
    return finish(client, result.result, result.route, opts);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function createFromShape(client: ArtifactSiteClient, shape: LocalShape, opts: PublishOptions): Promise<{ result: CreatedSite | VersionResult; route: PublishOutcome["route"] }> {
  const say = opts.onProgress ?? (() => {});
  switch (shape.type) {
    case "html":
    case "document": {
      if (shape.size > oneShotLimit()) {

        if (shape.type === "document" && path.extname(shape.file).toLowerCase() !== ".pdf") throw new Error("Office documents over the one-shot limit must be converted to PDF first");
        say(`large ${shape.type === "html" ? "HTML" : "PDF"} (${mb(shape.size)}): chunked upload`);
        return { result: await chunkedCreate(client, [{ relpath: path.basename(shape.file), absPath: shape.file, size: shape.size }], opts), route: "chunked" };
      }
      say(`uploading ${path.basename(shape.file)} (${mb(shape.size)})`);
      return uploadWithRecovery(client, [{ relpath: path.basename(shape.file), absPath: shape.file, size: shape.size }], opts, async () => client.createFile(path.basename(shape.file), new Uint8Array(await readFile(shape.file)), opts.title, opts.official), "file");
    }
    case "zip": {
      if (shape.size > oneShotLimit()) {
        const extracted = await extractZip(shape.file, await client.uploadLimits());
        if (extracted.skipped.length) say(`skipped ${extracted.skipped.length} hidden or excluded ZIP path(s): ${extracted.skipped.slice(0, 5).join(", ")}`);
        try { return { result: await chunkedCreate(client, extracted.files, opts), route: "chunked" }; }
        finally { await extracted.cleanup(); }
      }
      say(`uploading ${path.basename(shape.file)} (${mb(shape.size)})`);
      const extracted = await extractZip(shape.file, await client.uploadLimits());
      if (extracted.skipped.length) say(`skipped ${extracted.skipped.length} hidden or excluded ZIP path(s): ${extracted.skipped.slice(0, 5).join(", ")}`);
      try { return await uploadWithRecovery(client, extracted.files, opts, extracted.files.reduce((n, f) => n + f.size, 0) > oneShotLimit() ? undefined : async () => client.createZip(await zipFiles(extracted.files), opts.title, opts.official), "zip"); }
      finally { await extracted.cleanup(); }
    }
    case "dir": {
      preflightTree(shape.files, await client.uploadLimits());
      if (skippedLastWalk.length) say(`skipped ${skippedLastWalk.length} path(s) the platform would refuse: ${skippedLastWalk.slice(0, 5).join(", ")}${skippedLastWalk.length > 5 ? ", …" : ""}`);
      if (shape.size > oneShotLimit()) {
        say(`${shape.files.length} files, ${mb(shape.size)}: chunked upload`);
        return { result: await chunkedCreate(client, shape.files, opts), route: "chunked" };
      }
      say(`zipping ${shape.files.length} files (${mb(shape.size)})`);
      return uploadWithRecovery(client, shape.files, opts, async () => client.createZip(await zipFiles(shape.files), opts.title, opts.official), "zip");
    }
  }
}

type UploadOptions = PublishOptions & { slug?: string; expectedVersion?: string };
async function chunkedCreate(client: ArtifactSiteClient, files: WalkedFile[], opts: UploadOptions): Promise<VersionResult> {
  return (await uploadWithRecovery(client, files, opts)).result as VersionResult;
}
async function uploadWithRecovery(client: ArtifactSiteClient, files: WalkedFile[], opts: UploadOptions, inline?: () => Promise<CreatedSite | VersionResult>, inlineRoute: PublishOutcome["route"] = "zip"): Promise<{ result: CreatedSite | VersionResult; route: PublishOutcome["route"] }> {
  const say = opts.onProgress ?? (() => {});
  // Anonymous credentials are browser cookies: do not write them into a local journal.
  const state = client.authenticated ? await recovery(client, files, { operationKey: opts.operationKey, title: opts.title, slug: opts.slug, expectedVersion: opts.expectedVersion, official: opts.official }) : null;
  const j = state?.journal;
  const keyed = <T>(suffix: string, run: () => Promise<T>) => j ? client.withOperation(`${j.id}:${suffix}`, run) : run();
  let route: PublishOutcome["route"] = inline ? inlineRoute : "chunked";
  try {
    // A response can be lost after the transaction committed. Query before any further writes.
    if (j) {
      for (const suffix of ["inline", `commit:${j.generation}`]) {
        try {
          const status = await client.operationStatus(`${j.id}:${suffix}`);
          if (status.status === "completed" && status.result) { j.result = status.result; await state!.save(); say("Recovered the previously published artifact"); return { result: j.result, route: suffix === "inline" ? inlineRoute : "chunked" }; }
          if (status.status === "running") throw new Error("The previous publication is still running; retry later with the same files");
        } catch (error) {
          if (error instanceof ApiError && error.code === "site_not_found") throw new Error("Published artifact is no longer available; inspect it before using a new --operation-key to publish again");
          if (!(error instanceof ApiError && error.status === 404)) throw error;
          const attempted = suffix === "inline" ? j.inlineAttempted : j.commitAttempted;
          if (attempted && error.code !== "operation_not_found") throw new Error("This server cannot confirm the previous publication outcome. Inspect the artifact before starting a new operation; upgrade the server for automatic recovery.");
        }
      }
      if (j.result) throw new Error("The server cannot verify the cached publication; inspect the artifact before using a new --operation-key");
    }
    if (inline && !j?.versionId) {
      try {
        if (j) { j.inlineAttempted = true; await state!.save(); }
        const result = await keyed("inline", inline);
        if (j) { j.result = result as VersionResult; await state!.save(); }
        return { result, route };
      } catch (error) {
        const details = error instanceof ApiError ? error.body as { effect?: string } | null : null;
        if (!(error instanceof ApiError && error.status === 413 && error.code === "inline_upload_too_large" && details?.effect === "none")) throw error;
        preflightTree(files, await client.uploadLimits()); say("The server rejected the inline body before publication; switching to file uploads");
      }
    }
    preflightTree(files, await client.uploadLimits()); route = "chunked";
    let versionId = j?.versionId;
    if (versionId) {
      try {
        const status = await client.uploadStatus(versionId);
        j!.done = j!.done.filter(name => status.files.some(f => f.relpath === name && f.sha256 === state!.hashes.get(name) && files.some(local => local.relpath === name && local.size === f.bytes)));
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
        // Commit was checked above; only an uncommitted, expired session is restarted.
        versionId = undefined; j!.versionId = undefined; j!.done = []; j!.commitAttempted = false; j!.generation++; await state!.save();
      }
    }
    if (!versionId) {
      const opened = await keyed(`start:${j?.generation ?? 0}`, () => client.openUpload({ title: opts.title, slug: opts.slug }));
      versionId = opened.versionId;
      if (j) { j.versionId = versionId; await state!.save(); }
    }
    let done = 0;
    for (const f of files) {
      if (!j?.done.includes(f.relpath)) {
        await client.uploadFile(versionId, f.relpath, f.absPath);
        if (j) { j.done.push(f.relpath); await state!.save(); }
      }
      say(`  ${++done}/${files.length} ${f.relpath} (${mb(f.size)})`);
    }
    if (j) { j.commitAttempted = true; await state!.save(); }
    const result = await keyed(`commit:${j?.generation ?? 0}`, () => client.commitUpload(versionId!, opts.title, opts.expectedVersion, opts.official));
    if (j) { j.result = result; await state!.save(); }
    return { result, route };
  } catch (error) { await state?.failed(error); throw error; }
  finally { await state?.release(); }
}

async function finish(client: ArtifactSiteClient, site: CreatedSite | VersionResult, route: PublishOutcome["route"], opts: PublishOptions): Promise<PublishOutcome> {
  const siteUrl = client.absolute(site.url);
  const policy = opts.share === undefined ? "public" : opts.share;
  if (!policy) return { site, siteUrl, readerUrl: siteUrl, route };
  try {
    const share = await client.createShare(site.slug, { policy, source: "publish" });
    return { site, siteUrl, share, readerUrl: share.url, route };
  } catch (error) {
    // The site is already created; losing that fact because the share step failed would make the
    // caller publish it twice. Report both.
    return { site, siteUrl, readerUrl: siteUrl, route, shareError: error instanceof Error ? error.message : String(error) };
  }
}

export interface UpdateOptions {
  operationKey?: string;
  official?: boolean;
  /** Version id the change is based on (from `export`); a 409 means somebody else committed first. */
  expectedVersion?: string;
  onProgress?: (line: string) => void;
}

/** Replace a site's current content with a local path. The route follows the site's kind:
 *  single → /edit with the page; folder → /versions with a zip (or chunked when large);
 *  document → /versions with the file. The shape must match the kind — the server enforces it. */
export async function updateFromPath(client: ArtifactSiteClient, slug: string, target: string, opts: UpdateOptions = {}): Promise<VersionResult & { kind: SiteKind }> {
  const say = opts.onProgress ?? (() => {});
  const info = await client.getSite(slug);
  const shape = await inspect(target);
  switch (info.kind) {
    case "single": {
      const file = shape.type === "html" ? shape.file
        : shape.type === "dir" && shape.files.length === 1 && shape.files[0].relpath.endsWith(".html") ? shape.files[0].absPath
        : null;
      if (!file) throw new Error(`${slug} is a single-page site: give it one .html file`);
      say(`replacing the page from ${path.basename(file)}`);
      const content = await readFile(file, "utf8");
      const { result: r } = await uploadWithRecovery(client, [{ relpath: "index.html", absPath: file, size: Buffer.byteLength(content) }], { ...opts, slug },
        Buffer.byteLength(content) > oneShotLimit() ? undefined : () => opts.official
          ? client.replaceWithFile(slug, path.basename(file), new TextEncoder().encode(content), opts.expectedVersion, true)
          : client.edit(slug, { content }, opts.expectedVersion), "file");
      return { ...r, kind: "single" } as VersionResult & { kind: SiteKind };
    }
    case "folder": {
      if (shape.type === "zip") {
        say(`uploading ${path.basename(shape.file)}`);
        const extracted = await extractZip(shape.file, await client.uploadLimits());
        if (extracted.skipped.length) say(`skipped ${extracted.skipped.length} hidden or excluded ZIP path(s): ${extracted.skipped.slice(0, 5).join(", ")}`);
        try {
          const r = await uploadWithRecovery(client, extracted.files, { ...opts, slug }, extracted.files.reduce((n, f) => n + f.size, 0) > oneShotLimit() ? undefined : async () => client.replaceWithZip(slug, await zipFiles(extracted.files), opts.expectedVersion, opts.official));
          return { ...r.result, kind: "folder" } as VersionResult & { kind: SiteKind };
        } finally { await extracted.cleanup(); }
      }
      if (shape.type !== "dir") throw new Error(`${slug} is a file-tree site: give it a directory or a zip`);
      preflightTree(shape.files, await client.uploadLimits());
      if (shape.size > oneShotLimit()) {
        say(`${shape.files.length} files, ${mb(shape.size)}: chunked upload`);
        return { ...(await chunkedCreate(client, shape.files, { ...opts, slug })), kind: "folder" };
      }
      say(`zipping ${shape.files.length} files (${mb(shape.size)})`);
      return { ...(await uploadWithRecovery(client, shape.files, { ...opts, slug }, async () => client.replaceWithZip(slug, await zipFiles(shape.files), opts.expectedVersion, opts.official))).result, kind: "folder" } as VersionResult & { kind: SiteKind };
    }
    case "document": {
      if (shape.type !== "document") throw new Error(`${slug} is a document site: give it a pdf/pptx/ppt/docx/doc file`);
      if (shape.size > oneShotLimit()) {
        if (path.extname(shape.file).toLowerCase() !== ".pdf") throw new Error("Office documents over the one-shot limit must be converted to PDF first");
        return { ...(await chunkedCreate(client, [{ relpath: path.basename(shape.file), absPath: shape.file, size: shape.size }], { ...opts, slug })), kind: "document" };
      }
      say(`uploading ${path.basename(shape.file)}`);
      const r = await uploadWithRecovery(client, [{ relpath: path.basename(shape.file), absPath: shape.file, size: shape.size }], { ...opts, slug }, async () => client.replaceWithFile(slug, path.basename(shape.file), new Uint8Array(await readFile(shape.file)), opts.expectedVersion, opts.official), "file");
      return { ...r.result, kind: "document" } as VersionResult & { kind: SiteKind };
    }
  }
}

export function mb(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))}KB` : `${(bytes / 1048576).toFixed(1)}MB`;
}
