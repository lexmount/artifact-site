import { mcpTools } from "@/lib/mcp-tools";
// Run against the final image. No mocks: MCP SDK and installed CLI use the same live service.
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { execFile } from "node:child_process";
const base = process.env.MCP_E2E_URL;
const token = process.env.MCP_E2E_TOKEN;
describe.skipIf(!base || !token)("remote MCP final image", () => {
  it("discovers tools and completes independent MCP and CLI publish/export/update/delete workflows", async () => {
    expect((await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer invalid" }, body: "{}" })).status).toBe(401);
    const c = new Client({ name: "image-acceptance", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    for (const headers of [new Headers(), new Headers({ authorization: `Bearer ${token}` })]) {
      const response = await fetch(`${base}/api/sites/unknown/claim`, { method: "POST", headers });
      expect(response.status).toBe(410); expect((await response.json()).code).toBe("claim_disabled");
    }
    const created: string[] = [];
    const local = mkdtempSync(join(tmpdir(), "remote-cli-acceptance-"));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const out = await c.callTool({ name: `artifact_site_${name}`, arguments: args });
      expect(out.isError, JSON.stringify(out)).not.toBe(true);
      return JSON.parse((out.content as { text: string }[])[0].text);
    };
    try {
      expect((await c.listTools()).tools.map(t => [t.name, t.title])).toEqual(mcpTools);
      expect((await call("connection")).operator).toBe(true);
      const site = await call("publish", { html: "<html><body>MCP image acceptance</body></html>", official: true, share: false }); created.push(site.slug);
      const exported = await call("export", { slug: site.slug });
      expect(site.officialVersionId).toBe(exported.versionId);
      const bytes = await call("export", { slug: site.slug, version_id: exported.versionId, path: "index.html" });
      expect(Buffer.from(bytes.base64, "base64").toString()).toContain("MCP image acceptance");
      await call("update", { slug: site.slug, expected_version: exported.versionId, html: "<html><body>Updated through remote MCP</body></html>" });
      expect((await call("read", { slug: site.slug })).text).toContain("Updated through remote MCP");
      const officialInfo = await call("get_site", { slug: site.slug });
      expect(officialInfo.officialVersionId).toBe(exported.versionId);
      await call("clear_official", { slug: site.slug, expected_revision: officialInfo.officialRevision });
      await call("set_official", { slug: site.slug, version_id: exported.versionId, expected_revision: officialInfo.officialRevision + 1 });
      expect((await call("get_site", { slug: site.slug })).officialVersionId).toBe(exported.versionId);
      const version_id = (await call("upload_start", { title: "Large MCP tree" })).versionId;
      const binary = Buffer.alloc(3 * 1024 * 1024 + 7, 173);
      for (const [path, data] of [["index.html", Buffer.from("<html><body>Large tree</body></html>")], ["assets/data.bin", binary]] as const) {
        let index = 0;
        for (let offset = 0; offset < data.length; offset += 262144) await call("upload_write", { upload_id: version_id, path, final: offset + 262144 >= data.length, index: index++, base64: data.subarray(offset, offset + 262144).toString("base64") });
      }
      const tree = await call("publish", { upload_id: version_id, share: false }); created.push(tree.slug);
      const chunks: Buffer[] = []; let offset = 0;
      while (offset < binary.length) {
        const chunk = await call("export", { slug: tree.slug, version_id, path: "assets/data.bin", offset });
        chunks.push(Buffer.from(chunk.base64, "base64")); offset = chunk.nextOffset;
      }
      expect(Buffer.concat(chunks)).toEqual(binary);
      const env: NodeJS.ProcessEnv = { ...process.env, ARTIFACT_SITE_URL: base!, ARTIFACT_SITE_TOKEN: token! };
      const cli = (args: string[], input?: string): Promise<ReturnType<typeof JSON.parse>> => new Promise((resolve, reject) => {
        const child = execFile(process.execPath, ["cli/bin/artifact-site.js", "--json", ...args], { env, encoding: "utf8", timeout: 60000 }, (error, stdout) => {
          if (error) reject(error); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
        });
        child.stdin?.end(input);
      });
      const published = await cli(["publish", "-", "--official", "--share", "none"], "<html><body>CLI image acceptance</body></html>");
      const cliSlug = published.slug ?? published.site?.slug; expect(cliSlug).toBeTruthy(); created.push(cliSlug);
      expect((await cli(["read", "--", cliSlug])).text).toContain("CLI image acceptance");
      await cli(["update", "--title", "Renamed by CLI", "--", cliSlug]);
      const info = await cli(["info", "--shares", "--", cliSlug]);
      const edited = await cli(["edit", "--file", info.files[0], "--expected-version", info.currentVersionId, "--", cliSlug, "-"], "<html><body>CLI edited acceptance</body></html>");
      expect(edited.versionId).not.toBe(info.currentVersionId);
      expect(published.officialVersionId).toBe(info.currentVersionId);
      expect((await cli(["official", "set", cliSlug, edited.versionId])).officialVersionId).toBe(edited.versionId);
      await cli(["official", "clear", cliSlug]);
      expect((await cli(["info", cliSlug])).officialVersionId).toBeNull();
      expect((await cli(["read", "--", cliSlug])).text).toContain("CLI edited acceptance");
      const copied = await cli(["fork", "--", cliSlug]); created.push(copied.slug);
      expect(copied.slug).not.toBe(cliSlug);
      expect((await cli(["find", "edited", "acceptance"])).results.some((s: { slug: string }) => s.slug === cliSlug)).toBe(true);
      // Existing scripts retain their rename command too.
      await cli(["rename", "--", cliSlug, "Renamed by CLI"]);
      expect((await call("get_site", { slug: cliSlug })).title).toBe("Renamed by CLI");
      await cli(["delete", "--", cliSlug]); created.splice(created.indexOf(cliSlug), 1);
      env.ARTIFACT_SITE_ONE_SHOT_LIMIT = "1048576";
      writeFileSync(join(local, "index.html"), "<html><body>CLI chunked version one</body></html>");
      writeFileSync(join(local, "data.bin"), binary);
      const cliTree = await cli(["publish", local, "--share", "none"]);
      const treeSlug = cliTree.slug ?? cliTree.site?.slug; created.push(treeSlug);
      const archive = join(tmpdir(), `remote-cli-${Date.now()}.zip`);
      try {
        const exportedCli = await cli(["export", "--out", archive, "--", treeSlug]);
        expect(Buffer.from(unzipSync(readFileSync(archive))["data.bin"])).toEqual(binary);
        writeFileSync(join(local, "index.html"), "<html><body>CLI chunked version two</body></html>");
        await cli(["update", "--expected-version", exportedCli.versionId, "--", treeSlug, local]);
        expect((await cli(["read", "--", treeSlug])).text).toContain("CLI chunked version two");
      } finally { rmSync(archive, { force: true }); }

    } finally { for (const slug of created) await call("delete", { slug }); await c.close(); rmSync(local, { recursive: true, force: true }); }
  }, 120000);
});
