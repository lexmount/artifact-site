// The two operations agents and humans actually want — "put this online" and "replace what is
// online with this" — expressed once, on top of the client. Both pick the API route from the
// local shape and (for updates) the site's kind, so callers never have to know about modes.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ArtifactSiteClient, type CreatedSite, type SharePolicy, type ShareResult, type SiteKind, type VersionResult } from "./client.js";
import { inspect, oneShotLimit, skippedLastWalk, zipFiles, type LocalShape } from "./archive.js";

export interface PublishOptions {
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
  const created = await client.createPaste(html, opts.title);
  return finish(client, created, "paste", opts);
}

async function createFromShape(client: ArtifactSiteClient, shape: LocalShape, opts: PublishOptions): Promise<{ result: CreatedSite | VersionResult; route: PublishOutcome["route"] }> {
  const say = opts.onProgress ?? (() => {});
  switch (shape.type) {
    case "html":
    case "document": {
      if (shape.size > oneShotLimit()) {
        if (shape.type === "html") throw new Error(`${path.basename(shape.file)} is over ${mb(oneShotLimit())}; publish it inside a directory instead`);
        if (path.extname(shape.file).toLowerCase() !== ".pdf") throw new Error("Office documents over the one-shot limit must be converted to PDF first");
        say(`large PDF (${mb(shape.size)}): chunked upload`);
        return { result: await chunkedCreate(client, [{ relpath: path.basename(shape.file), absPath: shape.file, size: shape.size }], opts), route: "chunked" };
      }
      say(`uploading ${path.basename(shape.file)} (${mb(shape.size)})`);
      return { result: await client.createFile(path.basename(shape.file), new Uint8Array(await readFile(shape.file)), opts.title), route: "file" };
    }
    case "zip": {
      if (shape.size > oneShotLimit()) throw new Error(`${path.basename(shape.file)} is over ${mb(oneShotLimit())}; extract it and publish the directory (chunked upload)`);
      say(`uploading ${path.basename(shape.file)} (${mb(shape.size)})`);
      return { result: await client.createZip(new Uint8Array(await readFile(shape.file)), opts.title), route: "zip" };
    }
    case "dir": {
      if (skippedLastWalk.length) say(`skipped ${skippedLastWalk.length} path(s) the platform would refuse: ${skippedLastWalk.slice(0, 5).join(", ")}${skippedLastWalk.length > 5 ? ", …" : ""}`);
      if (shape.size > oneShotLimit()) {
        say(`${shape.files.length} files, ${mb(shape.size)}: chunked upload`);
        return { result: await chunkedCreate(client, shape.files, opts), route: "chunked" };
      }
      say(`zipping ${shape.files.length} files (${mb(shape.size)})`);
      return { result: await client.createZip(await zipFiles(shape.files), opts.title), route: "zip" };
    }
  }
}

async function chunkedCreate(client: ArtifactSiteClient, files: { relpath: string; absPath: string; size: number }[], opts: PublishOptions & { slug?: string; expectedVersion?: string }): Promise<VersionResult> {
  const say = opts.onProgress ?? (() => {});
  const { versionId } = await client.openUpload({ title: opts.title, slug: opts.slug });
  let done = 0;
  for (const f of files) {
    await client.uploadFile(versionId, f.relpath, f.absPath);
    done += 1;
    say(`  ${done}/${files.length} ${f.relpath} (${mb(f.size)})`);
  }
  return client.commitUpload(versionId, opts.title, opts.expectedVersion);
}

async function finish(client: ArtifactSiteClient, site: CreatedSite | VersionResult, route: PublishOutcome["route"], opts: PublishOptions): Promise<PublishOutcome> {
  const siteUrl = client.absolute(site.url);
  const policy = opts.share === undefined ? "public" : opts.share;
  if (!policy) return { site, siteUrl, readerUrl: siteUrl, route };
  try {
    const share = await client.createShare(site.slug, { policy });
    return { site, siteUrl, share, readerUrl: share.url, route };
  } catch (error) {
    // The site is already created; losing that fact because the share step failed would make the
    // caller publish it twice. Report both.
    return { site, siteUrl, readerUrl: siteUrl, route, shareError: error instanceof Error ? error.message : String(error) };
  }
}

export interface UpdateOptions {
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
      const r = await client.edit(slug, { content: await readFile(file, "utf8") }, opts.expectedVersion);
      return { ...r, kind: "single" };
    }
    case "folder": {
      if (shape.type === "zip") {
        say(`uploading ${path.basename(shape.file)}`);
        return { ...(await client.replaceWithZip(slug, new Uint8Array(await readFile(shape.file)), opts.expectedVersion)), kind: "folder" };
      }
      if (shape.type !== "dir") throw new Error(`${slug} is a file-tree site: give it a directory or a zip`);
      if (shape.size > oneShotLimit()) {
        say(`${shape.files.length} files, ${mb(shape.size)}: chunked upload`);
        return { ...(await chunkedCreate(client, shape.files, { slug, onProgress: opts.onProgress, expectedVersion: opts.expectedVersion })), kind: "folder" };
      }
      say(`zipping ${shape.files.length} files (${mb(shape.size)})`);
      return { ...(await client.replaceWithZip(slug, await zipFiles(shape.files), opts.expectedVersion)), kind: "folder" };
    }
    case "document": {
      if (shape.type !== "document") throw new Error(`${slug} is a document site: give it a pdf/pptx/ppt/docx/doc file`);
      if (shape.size > oneShotLimit()) {
        if (path.extname(shape.file).toLowerCase() !== ".pdf") throw new Error("Office documents over the one-shot limit must be converted to PDF first");
        return { ...(await chunkedCreate(client, [{ relpath: path.basename(shape.file), absPath: shape.file, size: shape.size }], { slug, onProgress: opts.onProgress, expectedVersion: opts.expectedVersion })), kind: "document" };
      }
      say(`uploading ${path.basename(shape.file)}`);
      return { ...(await client.replaceWithFile(slug, path.basename(shape.file), new Uint8Array(await readFile(shape.file)), opts.expectedVersion)), kind: "document" };
    }
  }
}

export function mb(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))}KB` : `${(bytes / 1048576).toFixed(1)}MB`;
}
