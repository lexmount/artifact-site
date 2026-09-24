// The command line end to end (argument parsing → client → output → exit code) against the fake API.
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ArtifactSiteClient } from "../src/client.js";
import { run, type Io } from "../src/cli.js";
import { hostKey } from "../src/config.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";

let server: FakeServer;
let dir: string;
let out: string[];
let err: string[];
let stdinText = "";
const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l), stdin: async () => stdinText, openUrl: async () => {} };
const makeClient = (base: string, token: string | null) => new ArtifactSiteClient({ baseUrl: base, token, sleep: async () => {} });
const cli = (...argv: string[]) => run(argv, io, makeClient);
const lastJson = () => JSON.parse(out.at(-1)!);

beforeAll(async () => {
  server = await startFakeServer();
  dir = await mkdtemp(path.join(tmpdir(), "ah-cli-"));
  process.env.ARTIFACT_SITE_CONFIG_DIR = path.join(dir, "config");
  delete process.env.ARTIFACT_SITE_TOKEN;
  delete process.env.ARTIFACT_SITE_URL;
  await writeFile(path.join(dir, "page.html"), "<html><head></head><body>cli</body></html>");
});
afterAll(() => server.close());
beforeEach(() => { out = []; err = []; });

describe("artifact-site CLI", () => {
  it("without a base URL: exit 2 with instructions", async () => {
    expect(await cli("list")).toBe(2);
    expect(err[0]).toMatch(/--base/);
  });

  it("refuses a base URL that is not http(s)", async () => {
    expect(await cli("--base", "file:///etc/passwd", "list")).toBe(1);
    expect(err[0]).toMatch(/must start with http/);
    expect(await cli("--base", "not a url", "list")).toBe(1);
  });

  it("without a token: exit 3 telling you to log in", async () => {
    expect(await cli("--base", server.url, "list")).toBe(3);
    expect(err[0]).toMatch(/artifact-site login/);
  });

  it("info --shares requires sign-in before making requests", async () => {
    const before = server.state.requests.length;
    expect(await cli("--base", server.url, "info", "example", "--shares")).toBe(3);
    expect(err[0]).toMatch(/artifact-site login/);
    expect(server.state.requests).toHaveLength(before);
  });

  it("login: prints the user_message first, waits for approval, stores token + base URL", async () => {
    server.state.approveAfterPolls = 2;
    expect(await cli("--base", server.url + "/", "login", "--no-open")).toBe(0);
    expect(out[0]).toMatch(/ABCD-EFGH/);
    expect(out.at(-1)).toMatch(/Signed in as dev@example.com/);
    // Stored per server: tokens/<host>, never one shared file.
    const tokenFile = path.join(dir, "config", "tokens", hostKey(server.url));
    expect((await readFile(tokenFile, "utf8"))).toMatch(/^ahp_/);
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path.join(dir, "config", "config.json"), "utf8"))).toMatchObject({ baseUrl: server.url, email: "dev@example.com" });
  });

  it("after login no --base is needed: whoami, publish, list, info, share, export, update, rollback, rename, delete", async () => {
    expect(await cli("--json", "whoami")).toBe(0);
    expect(lastJson().user.email).toBe("dev@example.com");

    expect(await cli("--json", "publish", path.join(dir, "page.html"), "--title", "CLI page")).toBe(0);
    const pub = lastJson();
    expect(pub.kind).toBe("single");
    expect(pub.readerUrl).toMatch(/\/v\//);

    expect(await cli("publish", path.join(dir, "page.html"), "--share", "none")).toBe(0);
    expect(out.join("\n")).toMatch(/Published page \(single, slug \w+\)/);
    expect(out.join("\n")).not.toMatch(/share:/);

    expect(await cli("--json", "list")).toBe(0);
    expect(lastJson().owned.length).toBeGreaterThanOrEqual(2);

    expect(await cli("--json", "info", pub.slug)).toBe(0);
    const info = lastJson();
    expect(info.files).toEqual(["page.html"]);

    expect(await cli("--json", "share", pub.slug, "--policy", "passcode", "--expires", "7")).toBe(0);
    expect(lastJson().passcode).toBe("123456");
    expect(await cli("share", pub.slug, "--policy", "bogus")).toBe(2);

    const zipPath = path.join(dir, "export.zip");
    expect(await cli("--json", "export", pub.slug, "-o", zipPath)).toBe(0);
    const exported = lastJson();
    expect(exported.versionId).toBe(info.currentVersionId);
    expect((await stat(zipPath)).size).toBeGreaterThan(0);

    expect(await cli("--json", "update", pub.slug, path.join(dir, "page.html"), "--expected-version", exported.versionId)).toBe(0);
    const updated = lastJson();
    expect(updated.versionId).not.toBe(exported.versionId);
    expect(await cli("update", pub.slug, path.join(dir, "page.html"), "--expected-version", exported.versionId, "--operation-key", "new-conflicting-update")).toBe(4);
    expect(err.at(-1)).toMatch(/export again and retry/);

    expect(await cli("--json", "rollback", pub.slug, exported.versionId)).toBe(0);
    expect(await cli("--json", "rename", pub.slug, "Better title")).toBe(0);
    expect(lastJson().title).toBe("Better title");
    expect(await cli("--json", "delete", pub.slug)).toBe(0);
    expect(lastJson()).toEqual({ deleted: true, slug: pub.slug });
    expect(await cli("info", pub.slug)).toBe(1);
    expect(err.at(-1)).toBe("error 404: site not found");
  });

  it("find consolidates list/search and title-only update preserves contents", async () => {
    expect(await cli("--json", "publish", path.join(dir, "page.html"), "--share", "none")).toBe(0);
    const slug = lastJson().slug;
    expect(await cli("--json", "find")).toBe(0);
    expect(lastJson().owned.some((s: { slug: string }) => s.slug === slug)).toBe(true);
    expect(await cli("--json", "info", slug)).toBe(0);
    const version = lastJson().currentVersionId;
    expect(await cli("--json", "update", slug, "--title", "Findable report")).toBe(0);
    expect(lastJson().title).toBe("Findable report");
    expect(await cli("--json", "find", "Findable")).toBe(0);
    expect(lastJson().results.some((s: { slug: string }) => s.slug === slug)).toBe(true);
    expect(await cli("--json", "info", slug)).toBe(0);
    expect(lastJson().currentVersionId).toBe(version);
    const before = server.state.requests.length;
    expect(await cli("update", slug)).toBe(2);
    expect(await cli("update", slug, path.join(dir, "page.html"), "--title", "ambiguous")).toBe(2);
    expect(await cli("find", "report", "--limit", "0")).toBe(2);
    expect(server.state.requests).toHaveLength(before);
  });

  it("ignores search-only limits when listing personal artifacts", async () => {
    expect(await cli("--json", "find", "--limit", "2")).toBe(0);
    expect(lastJson().owned).toBeInstanceOf(Array);
  });

  it("exposes single-file editing, copying and optional share inspection", async () => {
    expect(await cli("--json", "publish", path.join(dir, "page.html"), "--share", "none")).toBe(0);
    const slug = lastJson().slug;
    expect(await cli("--json", "info", slug)).toBe(0);
    const version = lastJson().currentVersionId, file = lastJson().files[0];
    stdinText = "<html><body>Edited through CLI</body></html>";
    expect(await cli("--json", "edit", slug, "-", "--file", file, "--expected-version", version)).toBe(0);
    expect(await cli("--json", "read", slug)).toBe(0);
    expect(lastJson().text).toContain("Edited through CLI");
    expect(await cli("edit", slug, "-", "--file", file, "--expected-version", version)).toBe(4);
    expect(await cli("--json", "fork", slug)).toBe(0);
    expect(lastJson().slug).not.toBe(slug);
    expect(await cli("--json", "share", slug)).toBe(0);
    expect(await cli("--json", "info", slug, "--shares")).toBe(0);
    expect(lastJson().shares).toHaveLength(1);
  });

  it("publish - reads HTML from stdin", async () => {
    stdinText = "<html><head></head><body>from stdin</body></html>";
    expect(await cli("--json", "publish", "-", "--share", "none")).toBe(0);
    expect(lastJson().route).toBe("paste");
  });

  it("search finds a published page by its words; read prints its text, one file, or a cut", async () => {
    await writeFile(path.join(dir, "walrus.html"), "<html><head><title>Walrus notes</title></head><body>the walrus habitat report</body></html>");
    expect(await cli("--json", "publish", path.join(dir, "walrus.html"), "--share", "none")).toBe(0);
    const slug = lastJson().slug as string;
    expect(await cli("--json", "search", "walrus", "habitat")).toBe(0);
    expect(lastJson().results.map((r: { slug: string }) => r.slug)).toContain(slug);
    expect(lastJson().results[0].url).toMatch(/^http/);
    expect(await cli("search", "nothing-matches-this-zzz")).toBe(0);
    expect(out.at(-1)).toBe("no matches");
    expect(await cli("read", slug)).toBe(0);
    expect(out.at(-1)).toContain("walrus habitat report");
    expect(await cli("--json", "info", slug)).toBe(0);
    const file = lastJson().files[0] as string;
    expect(await cli("--json", "read", slug, "--file", file)).toBe(0);
    expect(lastJson().text).toContain("<title>Walrus notes</title>");
    expect(lastJson().url).toMatch(/^http/);
    expect(await cli("read", slug, "--max-chars", "5")).toBe(0);
    expect(out.at(-1)).toHaveLength(5);
    expect(err.at(-1)).toMatch(/truncated/);
  });

  it("environment overrides: ARTIFACT_SITE_TOKEN is used and a revoked token maps to exit 3", async () => {
    process.env.ARTIFACT_SITE_TOKEN = "ahp_not_a_real_token";
    try {
      expect(await cli("list")).toBe(3);
      expect(err.at(-1)).toMatch(/error 401/);
    } finally { delete process.env.ARTIFACT_SITE_TOKEN; }
  });

  it("skill prints the served guide; logout forgets the token", async () => {
    expect(await cli("skill")).toBe(0);
    expect(out.join("\n")).toContain("**Base URL**");
    expect(await cli("logout")).toBe(0);
    expect(await cli("list")).toBe(3);
  });

  it("--version prints the package version and exits 0", async () => {
    expect(await cli("--version")).toBe(0);
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(out.at(-1)).toBe(pkg.version);
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("--help exits 0", async () => {
    expect(await cli("--help")).toBe(0);
    const help = out.join("\n");
    expect(help).toContain("my published artifacts");
    expect(help).not.toContain("Run `artifact-site mcp`");
    expect(help).not.toMatch(/^  (list|search|rename) /m);
    expect(help).toMatch(/^  find /m);
  });
});

it("accepts a hyphen-prefixed slug after the option separator", async () => {
  let requested = "";
  const code = await run(["--base", "https://example.test", "--json", "read", "--", "-leading-slug"], io, (base) => new ArtifactSiteClient({ baseUrl: base, fetch: async (input) => {
    requested = String(input);
    return Response.json({ slug: "-leading-slug", url: "/s/-leading-slug", text: "read successfully" });
  } }));
  expect(code).toBe(0);
  expect(new URL(requested).pathname).toBe("/api/sites/-leading-slug/text");
  expect(lastJson().text).toBe("read successfully");
});

it("supports official publication, replacement, historical designation and clearing", async () => {
  expect(await cli("--base", server.url, "login", "--no-open")).toBe(0);
  expect(await cli("--json", "publish", path.join(dir, "page.html"), "--official", "--share", "none")).toBe(0);
  const created = lastJson(), slug = created.slug;
  expect(created.officialVersionId).toBeTruthy();
  expect(await cli("--json", "update", slug, path.join(dir, "page.html"), "--official", "--expected-version", created.officialVersionId)).toBe(0);
  const updated = lastJson();
  expect(updated.officialVersionId).toBe(updated.versionId);
  expect(updated.officialVersionId).not.toBe(created.officialVersionId);
  expect(await cli("--json", "official", "set", slug, created.officialVersionId)).toBe(0);
  expect(lastJson().previousOfficialVersionId).toBe(updated.versionId);
  expect(await cli("--json", "info", slug)).toBe(0);
  expect(lastJson().officialVersionId).toBe(created.officialVersionId);
  expect(lastJson().currentVersionId).toBe(updated.versionId);
  expect(await cli("--json", "official", "clear", slug)).toBe(0);
  expect(lastJson().officialVersionId).toBeNull();
});

it("routes Agent comment commands and historical reads without exposing share credentials", async () => {
  const requests: Request[]=[];
  const factory=(baseUrl:string)=>new ArtifactSiteClient({baseUrl,shareToken:"private-share-token",fetch:async(input,init)=>{
    const request=new Request(input,init);requests.push(request);
    return new Response(JSON.stringify({dataTrust:"trusted",items:[],nextCursor:null,text:"historical",url:"/s/site",versionId:"old",truncated:false}),{headers:{"content-type":"application/json"}});
  }});
  const exec=(...args:string[])=>run(["--base","http://comments.test","--share-token","private-share-token","--json",...args],io,factory);
  expect(await exec("comments","list","site","--aggregate","--all-versions","--status","open","--limit","2")).toBe(0);
  expect(new URL(requests.at(-1)!.url).searchParams.get("allVersions")).toBe("true");
  expect(await exec("comments","list","site","--version-id","old")).toBe(0);
  expect(new URL(requests.at(-1)!.url).searchParams.get("versionId")).toBe("old");
  expect(await exec("comments","read","site","thread")).toBe(0);
  expect(lastJson().dataTrust).toBe("untrusted");
  expect(await exec("comments","read","site","thread","--cursor","next-page")).toBe(0);
  expect(lastJson().dataTrust).toBe("untrusted");
  expect(new URL(requests.at(-1)!.url).pathname).toBe("/api/sites/site/comments/thread/messages");
  expect(await exec("comments","context","site","thread")).toBe(0);
  expect(new URL(requests.at(-1)!.url).pathname).toBe("/api/sites/site/comments/thread/agent-context");
  expect(requests.at(-1)!.headers.get("x-artifact-share")).toBe("private-share-token");
  expect(await exec("read","site","--version-id","old")).toBe(0);
  expect(new URL(requests.at(-1)!.url).searchParams.get("version_id")).toBe("old");
  const count=requests.length;
  expect(await exec("comments","list","site","--all-versions")).toBe(2);
  expect(await exec("comments","read","site","thread","--limit","3")).toBe(2);
  expect(await exec("update","site","./output")).toBe(2);
  expect(requests).toHaveLength(count);
  expect(out.join("\n")).not.toContain("private-share-token");
});
