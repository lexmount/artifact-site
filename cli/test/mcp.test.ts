// `artifact-site mcp`: the local stdio server that forwards to a deployment's remote /mcp.
// In-process against a small remote MCP server over real HTTP, and end to end through the binary.
import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bundledManifest, createLocalMcpServer, describeRemoteError, type LocalMcpOptions } from "../src/mcp.js";

const cliDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOKEN = "ahp_valid";

/** A remote /mcp: one echo tool, one resource, instructions; 401 for any other token, 403 insufficient_scope for "ahp_read". */
interface Remote { url: string; auth: (string | undefined)[]; close(): Promise<void> }
async function startRemote(): Promise<Remote> {
  const auth: (string | undefined)[] = [];
  const http: HttpServer = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const header = req.headers.authorization;
    auth.push(header);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (header === "Bearer ahp_read" && body.method === "tools/call") {
      res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "This connection was authorized for reading only; authorize it again with artifacts:write to use this tool", code: "insufficient_scope", scope: "artifacts:write" }));
      return;
    }
    if (header !== `Bearer ${TOKEN}` && header !== "Bearer ahp_read") {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "The Bearer token is invalid, expired or revoked", code: "invalid_token" }));
      return;
    }
    const server = new McpServer({ name: "remote", version: "1" }, { instructions: "remote instructions" });
    server.registerTool("artifact_site_echo", { title: "Echo", description: "Echo", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } }, async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }));
    server.registerTool("artifact_site_fail", { description: "Fails", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "remote said no" }], isError: true }));
    server.registerResource("skill", "artifact-site://skill", { mimeType: "text/markdown" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# remote skill" }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    res.on("close", () => { void server.close(); });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const { port } = http.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, auth, close: () => new Promise((r) => http.close(() => r())) };
}

const logs: string[] = [];
async function local(o: Partial<LocalMcpOptions>) {
  const { server, close } = await createLocalMcpServer({ baseUrl: null, token: null, version: "test", log: (l) => logs.push(l), connectTimeoutMs: 3000, requestTimeoutMs: 3000, ...o });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, close: async () => { await client.close(); await close(); } };
}
const text = (r: { content?: unknown }) => (r.content as { text: string }[])[0].text;

let remote: Remote;
beforeAll(async () => { remote = await startRemote(); });
afterAll(() => remote.close());

describe("signed out", () => {
  it("starts, lists the 26 bundled tools and answers every call with how to sign in", async () => {
    logs.length = 0;
    const { client, close } = await local({});
    expect(client.getServerVersion()?.name).toBe("artifact-site");
    expect(client.getInstructions()).toBe(bundledManifest().instructions);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(26);
    expect(tools.every((t) => t.name.startsWith("artifact_site_") && t.inputSchema.type === "object" && t.description)).toBe(true);
    const call = await client.callTool({ name: "artifact_site_find", arguments: {} });
    expect(call.isError).toBe(true);
    expect(text(call)).toBe('Not signed in. Run "artifact-site login --base <url>" or set ARTIFACT_SITE_URL and ARTIFACT_SITE_TOKEN.');
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual(["artifact-site://skill"]);
    await expect(client.readResource({ uri: "artifact-site://skill" })).rejects.toThrow(/Not signed in/);
    expect(logs.join("\n")).toMatch(/Not signed in/);
    await close();
  });

  it("with an address but no token, names that address in the sign-in hint", async () => {
    const { client, close } = await local({ baseUrl: remote.url });
    const call = await client.callTool({ name: "artifact_site_find", arguments: {} });
    expect(text(call)).toBe(`Not signed in to ${remote.url}. Run "artifact-site login --base ${remote.url}" or set ARTIFACT_SITE_TOKEN.`);
    await close();
  });
});

describe("signed in", () => {
  it("forwards tools, calls, resources and instructions unchanged, with the Bearer token", async () => {
    remote.auth.length = 0;
    const { client, close } = await local({ baseUrl: remote.url, token: TOKEN });
    expect(client.getInstructions()).toBe("remote instructions");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["artifact_site_echo", "artifact_site_fail"]);
    expect(tools[0]).toMatchObject({ title: "Echo", annotations: { readOnlyHint: true }, inputSchema: { properties: { text: { type: "string" } }, required: ["text"] } });
    expect(await client.callTool({ name: "artifact_site_echo", arguments: { text: "hi" } })).toEqual({ content: [{ type: "text", text: "echo:hi" }] });
    // A remote tool error is the remote's answer, passed through as it is.
    const failed = await client.callTool({ name: "artifact_site_fail", arguments: {} });
    expect(failed.isError).toBe(true);
    expect(text(failed)).toBe("remote said no");
    expect((await client.readResource({ uri: "artifact-site://skill" })).contents[0]).toMatchObject({ text: "# remote skill" });
    expect(remote.auth.length).toBeGreaterThan(3);
    expect(remote.auth.every((a) => a === `Bearer ${TOKEN}`)).toBe(true);
    await close();
  });

  it("turns a rejected token into a tool error that says to sign in again, and keeps serving", async () => {
    logs.length = 0;
    const { client, close } = await local({ baseUrl: remote.url, token: "ahp_revoked" });
    expect(logs.join("\n")).toMatch(/rejected the token/);
    // tools/list falls back to the bundled list rather than failing the client.
    expect((await client.listTools()).tools).toHaveLength(26);
    const call = await client.callTool({ name: "artifact_site_find", arguments: {} });
    expect(call.isError).toBe(true);
    expect(text(call)).toBe(`${remote.url} rejected the token: it is invalid, expired or revoked. Run "artifact-site login --base ${remote.url}" again, or set a new ARTIFACT_SITE_TOKEN.`);
    expect((await client.callTool({ name: "artifact_site_find", arguments: {} })).isError).toBe(true);
    await close();
  });

  it("passes insufficient_scope through as the server worded it", async () => {
    const { client, close } = await local({ baseUrl: remote.url, token: "ahp_read" });
    const call = await client.callTool({ name: "artifact_site_echo", arguments: { text: "x" } });
    expect(call.isError).toBe(true);
    expect(text(call)).toBe("This connection was authorized for reading only; authorize it again with artifacts:write to use this tool");
    await close();
  });

  it("reports an unreachable server as a readable tool error", async () => {
    const dead = createServer(); await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const { port } = dead.address() as { port: number }; await new Promise((r) => dead.close(r));
    const base = `http://127.0.0.1:${port}`;
    const { client, close } = await local({ baseUrl: base, token: TOKEN });
    expect((await client.listTools()).tools).toHaveLength(26);
    const call = await client.callTool({ name: "artifact_site_find", arguments: {} });
    expect(call.isError).toBe(true);
    expect(text(call)).toBe(`Cannot reach ${base}/mcp: ECONNREFUSED`);
    await close();
  });
});

describe("shutdown", () => {
  it("close() during an in-flight handshake aborts it, returns at once and leaves no client behind", async () => {
    // A remote whose first initialize fails (so the startup connection is abandoned and the first call
    // connects again) and whose second initialize does not answer until released.
    const seen: string[] = [];
    let initializes = 0; let release: (() => void) | null = null;
    const http = createServer(async (req, res) => {
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method: string; id?: number };
      seen.push(body.method);
      if (body.method === "initialize" && ++initializes === 1) { res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "warming up" })); return; }
      if (body.method === "initialize") await new Promise<void>((r) => { release = r; });
      if (body.method.startsWith("notifications/")) { res.writeHead(202).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "slow", version: "1" } } }));
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    try {
      logs.length = 0;
      const { client, close } = await local({ baseUrl: base, token: TOKEN });
      expect(logs.join("\n")).toMatch(/answered HTTP 503/);
      const call = client.callTool({ name: "artifact_site_find", arguments: {} }).catch((error: Error) => error);
      for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setTimeout(r, 10));
      expect(release).not.toBeNull();
      const started = Date.now();
      await close();
      // connectTimeoutMs is 3000 here: an aborted handshake returns at once, one left to time out would not.
      expect(Date.now() - started).toBeLessThan(1500);
      expect(await call).toBeInstanceOf(Error);
      // The remote answers late. Nothing may pick that up: a kept client would complete the handshake.
      release!();
      await new Promise((r) => setTimeout(r, 300));
      expect(seen.filter((m) => m === "notifications/initialized")).toEqual([]);
    } finally { http.closeAllConnections(); await new Promise<void>((r) => http.close(() => r())); }
  });
});

describe("describeRemoteError", () => {
  const scope = "This connection was authorized for reading only; authorize it again with artifacts:write to use this tool";
  const body = JSON.stringify({ error: scope, code: "insufficient_scope", scope: "artifacts:write" });

  it("reads the HTTP error body whatever the SDK's wording around it", () => {
    // The SDK folds the body into its message behind words of its own, which have changed between
    // releases; the body, not the wording, is what carries the server's answer.
    for (const wording of ["Error POSTing to endpoint: ", "Error POSTing to endpoint (HTTP 403): ", "POST https://x/mcp failed (403): "]) {
      expect(describeRemoteError(new StreamableHTTPError(403, wording + body), "https://x")).toBe(scope);
    }
    expect(describeRemoteError(new StreamableHTTPError(403, `Error POSTing to endpoint: ${JSON.stringify({ error: "Cross-site request rejected" })}`), "https://x"))
      .toBe('https://x refused the request (Cross-site request rejected): the token may be invalid or expired. Run "artifact-site login --base https://x" again, or set a new ARTIFACT_SITE_TOKEN.');
  });

  it("keeps a body that is not JSON readable", () => {
    expect(describeRemoteError(new StreamableHTTPError(502, "Error POSTing to endpoint: <html>Bad Gateway</html>"), "https://x")).toBe("https://x/mcp answered HTTP 502: <html>Bad Gateway</html>");
    expect(describeRemoteError(new StreamableHTTPError(429, "Error POSTing to endpoint: "), "https://x")).toBe("https://x/mcp answered HTTP 429");
  });
});

describe("artifact-site mcp (the binary)", () => {
  let env: Record<string, string>;
  beforeAll(async () => {
    execFileSync("npm", ["run", "build"], { cwd: cliDir, stdio: "ignore" });
    // A clean machine: no stored config, no URL or token in the environment.
    const home = await mkdtemp(path.join(tmpdir(), "ah-mcp-"));
    env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/^ARTIFACT_(SITE|HUB)_/.test(k))) as Record<string, string>;
    Object.assign(env, { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), ARTIFACT_SITE_CONFIG_DIR: path.join(home, "config") });
  }, 120_000);

  it("serves the bundled tools over stdio, signed out", async () => {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(cliDir, "bin/artifact-site.js"), "mcp"], env, stderr: "pipe" }));
    expect((await client.listTools()).tools).toHaveLength(26);
    expect((await client.callTool({ name: "artifact_site_find", arguments: {} })).isError).toBe(true);
    await client.close();
  });

  it("writes nothing but JSON-RPC to stdout, forwards when configured, and exits 0 when stdin ends", async () => {
    const child = spawn(process.execPath, [path.join(cliDir, "bin/artifact-site.js"), "mcp"], { env: { ...env, ARTIFACT_SITE_URL: remote.url, ARTIFACT_SITE_TOKEN: TOKEN }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const send = (m: object) => child.stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "artifact_site_echo", arguments: { text: "e2e" } } });
    for (let i = 0; i < 100 && stdout.split("\n").filter(Boolean).length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    child.stdin.end();
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    expect(code).toBe(0);
    const lines = stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.every((m) => m.jsonrpc === "2.0")).toBe(true);
    expect(lines.find((m) => m.id === 1).result.instructions).toBe("remote instructions");
    expect(lines.find((m) => m.id === 2).result).toEqual({ content: [{ type: "text", text: "echo:e2e" }] });
    expect(stderr).toMatch(/forwarding to/);
  });
});
