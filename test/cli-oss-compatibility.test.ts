import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { ArtifactSiteClient } from "../cli/src/client";
import { run } from "../cli/src/cli";
import { POST as create } from "@/app/api/sites/route";
import { POST as edit } from "@/app/api/sites/[slug]/edit/route";
import { GET as download } from "@/app/api/sites/[slug]/download/route";
import { GET as exportZip } from "@/app/api/sites/[slug]/export/route";
import { POST as share } from "@/app/api/sites/[slug]/shares/route";
import { POST as rollback } from "@/app/api/sites/[slug]/rollback/route";
import { GET as read } from "@/app/api/sites/[slug]/text/route";
import { upsertUser } from "@/lib/db";
import { mintSession } from "@/lib/session";
import { POST as mint } from "@/app/api/me/tokens/route";
import ts from "typescript";
import { createUploadSession } from "@/lib/upload-session";
import { getStorage } from "@/lib/storage";
import { PACKAGE_ENTRY, PACKAGE_ORIGINAL } from "@/lib/package-contract";
import { writePackageDirectory } from "@/lib/package-directory";
import { commitUploadedVersion } from "@/lib/sites";
import { testAudit } from "./helpers";

afterEach(() => vi.unstubAllEnvs());

it("keeps CLI API paths and bundled skill tools within the public server surface", async () => {
  const routes = (await readdir("src/app/api", { recursive: true })).filter(file => file.endsWith("/route.ts"))
    .map(file => `/api/${file.slice(0, -9).replace(/\[\.\.\.[^\]]+\]/g, "path/to/file").replace(/\[[^\]]+\]/g, "parameter")}`);
  const source = ts.createSourceFile("client.ts", await readFile("cli/src/client.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const paths: { source: string; pattern: string }[] = [];
  function visit(node: ts.Node) {
    if (ts.isStringLiteralLike(node) && node.text.startsWith("/api/")) {
      paths.push({ source: node.text, pattern: escape(node.text) });
    } else if (ts.isTemplateExpression(node) && node.head.text.startsWith("/api/")) {
      let pattern = escape(node.head.text);
      for (const span of node.templateSpans) {
        // Paths, optional suffixes and endpoint unions can span more than one route segment.
        pattern += ".*" + escape(span.literal.text.split("?")[0]);
        if (span.literal.text.includes("?")) break;
      }
      paths.push({ source: node.getText(source), pattern });
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(paths.length).toBeGreaterThan(30);
  for (const route of paths) expect(routes.some(path => new RegExp(`^${route.pattern}$`).test(path)), route.source).toBe(true);

  const manifest = JSON.parse(await readFile("cli/src/mcp-tools.json", "utf8"));
  const names = new Set(manifest.tools.map((tool: { name: string }) => tool.name));
  const topics = JSON.parse(await readFile("skills/artifact-site/topics.json", "utf8")) as { id: string }[];
  for (const { id } of topics) {
    const reference = await readFile(`skills/artifact-site/references/${id}.md`, "utf8");
    for (const name of reference.matchAll(/\bartifact_site_[a-z_]+\b/g)) expect(names.has(name[0]), `${id}: ${name[0]}`).toBe(true);
  }
  expect(topics.map(topic => topic.id)).not.toContain("records");
  expect(topics.map(topic => topic.id)).not.toContain("data");
});

it("uses public route handlers for historical reads, ZIP export, download, fixed shares and rollback", async () => {
  const origin = "http://localhost";
  const user = await upsertUser({ authProvider: "cli-compatibility", providerSubject: "owner" });
  const { cookie } = await mintSession(new Request(origin), user.id);
  const tokenResponse = await mint(new Request(`${origin}/api/me/tokens`, { method: "POST", headers: {
    cookie: cookie.split(";")[0], origin, "content-type": "application/json",
  }, body: JSON.stringify({ name: "CLI compatibility" }) }));
  expect(tokenResponse.status).toBe(201);
  const { token } = await tokenResponse.json();
  vi.stubEnv("ARTIFACT_SITE_TOKEN", token);
  const paths: string[] = [];
  const client = new ArtifactSiteClient({ baseUrl: origin, token, retries: 0, fetch: async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    paths.push(url.pathname);
    if (url.pathname === "/api/sites") return create(request);
    const [, , , slug, action] = url.pathname.split("/");
    const context = { params: Promise.resolve({ slug }) };
    switch (`${request.method} ${action}`) {
      case "POST edit": return edit(request, context);
      case "GET download": return download(request, context);
      case "GET export": return exportZip(request, context);
      case "GET text": return read(request, context);
      case "POST shares": return share(request, context);
      case "POST rollback": return rollback(request, context);
      default: throw new Error(`No public route for ${request.method} ${url.pathname}`);
    }
  } });
  const site = await client.createPaste("<h1>First version</h1>");
  const first = (await client.readText(site.slug)).versionId;
  const second = await client.edit(site.slug, { content: "<h1>Second version</h1>" }, first);
  expect((await client.readText(site.slug, { versionId: first })).text).toContain("First version");
  const historical = await client.export(site.slug, first);
  expect(historical.versionId).toBe(first);
  expect(strFromU8(unzipSync(historical.zip)["index.html"])).toContain("First version");
  const directory = await mkdtemp(join(tmpdir(), "cli-oss-"));
  const output: string[] = [], errors: string[] = [];
  const cli = (...args: string[]) => run(["--base", origin, "--json", ...args], {
    out: value => output.push(value), err: value => errors.push(value), stdin: async () => "",
  }, () => client);
  try {
    for (const command of ["download", "export"]) {
      const file = join(directory, `${command}.zip`);
      expect(await cli(command, "--version-id", first, "--out", file, "--", site.slug), errors.join("\n")).toBe(0);
      expect(paths.at(-1)).toBe(`/api/sites/${site.slug}/${command}`);
      expect(JSON.parse(output.at(-1)!).versionId).toBe(first);
      expect(strFromU8(unzipSync(await readFile(file))["index.html"])).toContain("First version");
    }
    expect(await cli("share", "--mode", "comment", "--version-id", first, "--", site.slug), errors.join("\n")).toBe(0);
    expect(JSON.parse(output.at(-1)!).share).toMatchObject({ versionId: first, mode: "comment" });
    expect(await cli("share", "--mode", "edit", "--version-id", first, "--", site.slug)).not.toBe(0);
    expect(await cli("rollback", "--", site.slug, first), errors.join("\n")).toBe(0);
    const restored = await client.readText(site.slug);
    expect(restored.versionId).not.toBe(first);
    expect(restored.versionId).not.toBe(second.versionId);
    expect(restored.text).toContain("First version");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("downloads a retained non-ZIP archive but exports its files as a ZIP", async () => {
  const original = Buffer.from("retained archive fixture");
  const session = await createUploadSession({ ownerKey: "a:cli-download" });
  const meta = { source: "archive" as const, files: [{ path: "note.txt", size: 4 }], directories: [], ignored: [],
    archive: { name: "source.rar", format: "rar" as const, size: original.length, sha256: "fixture" } };
  await getStorage().writeFileToVersion(session.siteId, session.versionId, PACKAGE_ORIGINAL, original);
  await getStorage().writeFileToVersion(session.siteId, session.versionId, "note.txt", Buffer.from("note"));
  await writePackageDirectory(session.siteId, session.versionId, meta, "Archive");
  const site = await commitUploadedVersion(new Request("http://localhost/api/uploads"), {
    session, entry: PACKAGE_ENTRY, packageMeta: meta, ctx: testAudit(),
  });
  const client = new ArtifactSiteClient({ baseUrl: "http://localhost", retries: 0, fetch: async (input, init) => {
    const request = new Request(input, init);
    request.headers.set("x-edit-token", site.editToken!);
    return (new URL(request.url).pathname.endsWith("/export") ? exportZip : download)(request, { params: Promise.resolve({ slug: site.slug }) });
  } });
  const directory = await mkdtemp(join(tmpdir(), "cli-archive-"));
  try {
    const archive = join(directory, "source.rar"), zip = join(directory, "source.zip");
    expect((await client.downloadToFile(site.slug, { out: archive })).filename).toBe("source.rar");
    expect(await readFile(archive)).toEqual(original);
    await client.exportToFile(site.slug, { out: zip });
    const files = unzipSync(await readFile(zip));
    expect(Object.keys(files)).toEqual(["note.txt"]);
    expect(strFromU8(files["note.txt"])).toBe("note");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
