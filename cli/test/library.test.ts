import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ArtifactSiteClient } from "../src/client.js";
import { run } from "../src/cli.js";
const out: string[] = [], err: string[] = [], requests: { path: string; method: string; body?: unknown }[] = [];
let status = 200, operator = false;
beforeEach(() => { vi.stubEnv("ARTIFACT_SITE_TOKEN", "ahp_test"); out.length = err.length = requests.length = 0; status = 200; operator = false; });
afterEach(() => vi.unstubAllEnvs());
const exec = (...args: string[]) => run(["--base", "https://library.test", ...args], { out: s => out.push(s), err: s => err.push(s), stdin: async () => "" }, (baseUrl, token) => new ArtifactSiteClient({ baseUrl, token, retries: 0, fetch: async (input, init) => {
  const r = new Request(input, init), path = new URL(r.url).pathname;
  const body = r.method === "PUT" ? await r.json() : undefined;
  requests.push({ path, method: r.method, body });
  if (status !== 200) return Response.json({ error: "request failed" }, { status });
  return Response.json(path.endsWith("/assignments") ? { ok: true, ...body }
    : path === "/api/me/folders" ? { folders: [{ id: "fld_a", name: "Reports", createdAt: 1 }], assign: {} }
    : path === "/api/auth/me" ? { user: null, operator, oidcEnabled: true }
    : path === "/api/me/sites" ? { owned: [], collaborating: [] }
    : path === "/api/sites" ? { sites: [{ slug: "pub", kind: "single", title: "Public report" }] }
    : { query: "report", results: [{ slug: "mine", kind: "single", title: "My report", visibility: "public", relationship: "owned", url: "/s/mine", snippet: "report" }, { slug: "pub", kind: "single", title: "Other report", relationship: "public", visibility: "public", url: "/s/pub", snippet: "report" }] });
} }));
it("lists folders and files or unfiles an artifact with structured output", async () => {
  expect(await exec("--json", "folders", "list")).toBe(0);
  expect(JSON.parse(out.at(-1)!)).toMatchObject({ scope: "mine", folders: [{ id: "fld_a", name: "Reports" }] });
  expect(await exec("--json", "move", "report", "--folder", "fld_a")).toBe(0);
  expect(requests.at(-1)).toEqual({ path: "/api/me/folders/assignments", method: "PUT", body: { slug: "report", folderId: "fld_a" } });
  expect(await exec("move", "report", "--unfiled")).toBe(0);
  expect(requests.at(-1)?.body).toEqual({ slug: "report", folderId: null });
});
it("rejects ambiguous move arguments without making requests", async () => {
  expect(await exec("move", "report")).toBe(2);
  expect(await exec("move", "report", "--folder", "fld_a", "--unfiled")).toBe(2);
  expect(await exec("move", "report", "--folder", "")).toBe(2);
  expect(requests).toEqual([]);
});
it("keeps personal failures distinct from explicit public browsing", async () => {
  status = 401;
  expect(await exec("find")).toBe(3);
  expect(requests.map(r => r.path)).toEqual(["/api/me/sites"]);
  status = 200;
  expect(await exec("--json", "find", "--public")).toBe(0);
  expect(JSON.parse(out.at(-1)!)).toMatchObject({ scope: "public", sites: [{ slug: "pub" }] });
  expect(await exec("find", "report", "--public")).toBe(2);
});
it("labels mixed results and recognizes operator identity without publishing", async () => {
  expect(await exec("find", "report")).toBe(0);
  expect(out.join("\n")).toContain("[owned]"); expect(out.join("\n")).toContain("[public]");
  operator = true;
  expect(await exec("--json", "whoami")).toBe(0);
  expect(JSON.parse(out.at(-1)!)).toMatchObject({ tokenStatus: "operator", user: null, operator: true });
  expect(requests.every(r => r.method === "GET")).toBe(true);
});
