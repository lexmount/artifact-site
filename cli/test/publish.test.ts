// publishPath / updateFromPath pick the right route from what is on disk and what the site is.
process.env.ARTIFACT_SITE_ONE_SHOT_LIMIT = String(64 * 1024); // 64KB, so "large" is cheap to fabricate
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactSiteClient } from "../src/client.js";
import { inspect, skippedLastWalk, walkDir } from "../src/archive.js";
import { publishHtml, publishPath, updateFromPath } from "../src/publish.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";

let server: FakeServer;
let client: ArtifactSiteClient;
let dir: string;
const html = (body: string) => `<html><head></head><body>${body}</body></html>`;

beforeAll(async () => {
  server = await startFakeServer();
  client = new ArtifactSiteClient({ baseUrl: server.url, token: server.token(), sleep: async () => {} });
  dir = await mkdtemp(path.join(tmpdir(), "ah-publish-"));
  process.env.ARTIFACT_SITE_CONFIG_DIR = path.join(dir, "config");
  await mkdir(path.join(dir, "site/assets"), { recursive: true });
  await mkdir(path.join(dir, "site/node_modules/x"), { recursive: true });
  await mkdir(path.join(dir, "site/.git"), { recursive: true });
  await writeFile(path.join(dir, "site/index.html"), html("tree"));
  await writeFile(path.join(dir, "site/assets/app.css"), "body{}");
  await writeFile(path.join(dir, "site/node_modules/x/index.js"), "junk");
  await writeFile(path.join(dir, "site/.git/HEAD"), "ref");
  await writeFile(path.join(dir, "site/.DS_Store"), "junk");
  await writeFile(path.join(dir, "page.html"), html("single"));
  await writeFile(path.join(dir, "deck.pptx"), Buffer.from([0x50, 0x4b, 3, 4, 9, 9]));
  await writeFile(path.join(dir, "bundle.zip"), zipSync({ "dist/index.html": new TextEncoder().encode(html("zipped")), "dist/a.js": new TextEncoder().encode("1") }));
  await mkdir(path.join(dir, "big"), { recursive: true });
  await writeFile(path.join(dir, "big/index.html"), html("big"));
  await writeFile(path.join(dir, "big/media/clip.bin").replace("/media", ""), Buffer.alloc(100 * 1024, 7)); // 100KB > 64KB limit
  await writeFile(path.join(dir, "big.pdf"), Buffer.concat([Buffer.from("%PDF"), Buffer.alloc(100 * 1024, 1)]));
});
afterAll(() => server.close());

describe("archive", () => {
  it("walks a directory skipping node_modules, every dot-leading path (.git, .env, .DS_Store) and junk, and reports them", async () => {
    await writeFile(path.join(dir, "site/.env"), "SECRET=1");
    await writeFile(path.join(dir, "site/assets/.hidden.css"), "");
    const files = await walkDir(path.join(dir, "site"));
    expect(files.map((f) => f.relpath)).toEqual(["assets/app.css", "index.html"]);
    expect(skippedLastWalk.sort()).toEqual([".DS_Store", ".env", ".git", "assets/.hidden.css", "node_modules"]);
  });

  it("publishing a directory tells the caller what was left out", async () => {
    const lines: string[] = [];
    await publishPath(client, path.join(dir, "site"), { share: false, onProgress: (l) => lines.push(l) });
    expect(lines[0]).toMatch(/skipped 5 path\(s\).*\.env/);
  });
  it("classifies local shapes", async () => {
    expect((await inspect(path.join(dir, "page.html"))).type).toBe("html");
    expect((await inspect(path.join(dir, "deck.pptx"))).type).toBe("document");
    expect((await inspect(path.join(dir, "bundle.zip"))).type).toBe("zip");
    expect((await inspect(path.join(dir, "site"))).type).toBe("dir");
    await expect(inspect(path.join(dir, "site/assets/app.css"))).rejects.toThrow(/Unsupported file type/);
  });
});

describe("publishPath", () => {
  it("a single .html goes one-shot as a file and gets a public share by default", async () => {
    const out = await publishPath(client, path.join(dir, "page.html"));
    expect(out.route).toBe("file");
    expect(out.site.kind).toBe("single");
    expect(out.share?.share.policy).toBe("public");
    expect(out.readerUrl).toBe(out.share!.url);
    expect(out.siteUrl).toBe(`${server.url}/s/${out.site.slug}`);
  });

  it("a directory under the limit is zipped in memory; node_modules never reaches the server", async () => {
    const out = await publishPath(client, path.join(dir, "site"), { share: false, title: "Tree" });
    expect(out.route).toBe("zip");
    expect(out.readerUrl).toBe(out.siteUrl);
    const stored = server.state.sites.get(out.site.slug)!.versions[0].files;
    expect(Object.keys(stored).sort()).toEqual(["assets/app.css", "index.html"]);
  });

  it("a .zip is forwarded as is (the server flattens the wrapper directory)", async () => {
    const out = await publishPath(client, path.join(dir, "bundle.zip"), { share: false });
    expect(Object.keys(server.state.sites.get(out.site.slug)!.versions[0].files).sort()).toEqual(["a.js", "index.html"]);
  });

  it("a document goes as a file and is a document site", async () => {
    const out = await publishPath(client, path.join(dir, "deck.pptx"), { share: "login" });
    expect(out.site.kind).toBe("document");
    expect(out.share?.share.policy).toBe("login");
  });

  it("a directory over the limit takes the chunked route, streaming every file", async () => {
    const lines: string[] = [];
    const out = await publishPath(client, path.join(dir, "big"), { share: false, onProgress: (l) => lines.push(l) });
    expect(out.route).toBe("chunked");
    expect(lines[0]).toMatch(/chunked upload/);
    const puts = server.state.requests.filter((r) => r.method === "PUT" && r.path.includes("/files/"));
    expect(puts.map((r) => r.path.split("/files/")[1]).sort()).toEqual(["clip.bin", "index.html"]);
    expect(server.state.sites.get(out.site.slug)!.versions[0].files["clip.bin"].byteLength).toBe(100 * 1024);
  });

  it("a large PDF also takes the chunked route and becomes a document site", async () => {
    const out = await publishPath(client, path.join(dir, "big.pdf"), { share: false });
    expect(out.route).toBe("chunked");
    expect(out.site.kind).toBe("document");
  });

  it("inline HTML publishes as paste", async () => {
    const out = await publishHtml(client, html("inline"), { title: "Inline", share: false });
    expect(out.route).toBe("paste");
    expect(out.site.title).toBe("Inline");
  });
});

describe("updateFromPath", () => {
  it("single-page site: one .html → /edit; a directory is refused", async () => {
    const created = await publishHtml(client, html("v1"), { share: false });
    const v1 = (await client.listVersions(created.site.slug)).currentVersionId;
    const r = await updateFromPath(client, created.site.slug, path.join(dir, "page.html"), { expectedVersion: v1 });
    expect(r.kind).toBe("single");
    expect(r.versionId).not.toBe(v1);
    await expect(updateFromPath(client, created.site.slug, path.join(dir, "site"))).rejects.toThrow(/single-page site/);
    expect((await updateFromPath(client, created.site.slug, path.join(dir, "page.html"), { expectedVersion: v1 })).versionId).toBe(r.versionId);
    await expect(updateFromPath(client, created.site.slug, path.join(dir, "page.html"), { expectedVersion: v1, operationKey: "different-update" })).rejects.toMatchObject({ status: 409 });
  });

  it("folder site: a directory is zipped to /versions; a large one is chunked under the same slug", async () => {
    const created = await publishPath(client, path.join(dir, "site"), { share: false });
    const r = await updateFromPath(client, created.site.slug, path.join(dir, "bundle.zip"));
    expect(r.kind).toBe("folder");
    const big = await updateFromPath(client, created.site.slug, path.join(dir, "big"));
    expect(big.slug).toBe(created.site.slug);
    expect((await client.listVersions(created.site.slug)).versions).toHaveLength(3);
    await expect(updateFromPath(client, created.site.slug, path.join(dir, "page.html"))).rejects.toThrow(/file-tree site/);
  });

  it("document site: the new file → /versions; a directory is refused", async () => {
    const created = await publishPath(client, path.join(dir, "deck.pptx"), { share: false });
    const r = await updateFromPath(client, created.site.slug, path.join(dir, "deck.pptx"));
    expect(r.kind).toBe("document");
    await expect(updateFromPath(client, created.site.slug, path.join(dir, "site"))).rejects.toThrow(/document site/);
  });
});

it("skips and reports hidden ZIP entries on both inline and chunked routes", async () => {
  const zip = path.join(dir, "hidden.zip");
  await writeFile(zip, zipSync({ "index.html": Buffer.from(html("hidden ZIP")), ".nojekyll": Buffer.from(""), ".env": Buffer.from("SECRET"), ".well-known/data": Buffer.from("hidden") }));
  for (const limit of [100000, 1]) {
    process.env.ARTIFACT_SITE_ONE_SHOT_LIMIT = String(limit);
    const lines: string[] = [];
    try {
      const result = await publishPath(client, zip, { share: false, operationKey: `hidden-${limit}`, onProgress: line => lines.push(line) });
      expect(Object.keys(server.state.sites.get(result.site.slug)!.versions[0].files)).toEqual(["index.html"]);
      expect(lines.some(line => /skipped 3/.test(line))).toBe(true);
    } finally { process.env.ARTIFACT_SITE_ONE_SHOT_LIMIT = String(64 * 1024); }
  }
});
