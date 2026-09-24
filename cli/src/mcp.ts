// `artifact-site mcp`: a local stdio MCP server that forwards to the deployment's remote `/mcp`.
// No tool is implemented here. tools/list, tools/call, resources/list and resources/read go to the
// remote server with this machine's stored (or environment) credential, and come back unchanged —
// names, schemas, results and the server instructions. The one local addition is the bundled tool
// list (mcp-tools.json, generated from the server's own registrations): without a base URL or a
// token, the server still starts and lists its tools, which is how directories inspect it, and
// every call answers with how to sign in instead of failing the process.
//
// stdout carries JSON-RPC and nothing else; every diagnostic goes to `log` (stderr).
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema, CallToolResultSchema, ErrorCode, ListResourcesRequestSchema, ListResourcesResultSchema,
  ListResourceTemplatesRequestSchema, ListToolsRequestSchema, ListToolsResultSchema, McpError, ReadResourceRequestSchema,
  ReadResourceResultSchema, type CallToolResult, type ListResourcesResult, type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

export interface BundledManifest {
  instructions: string;
  tools: ListToolsResult["tools"];
  resources: ListResourcesResult["resources"];
}

/** Read beside the compiled file (dist/ → ../src/) and beside the source (src/ → ../src/) alike. */
export function bundledManifest(): BundledManifest {
  return JSON.parse(readFileSync(new URL("../src/mcp-tools.json", import.meta.url), "utf8")) as BundledManifest;
}

export interface LocalMcpOptions {
  /** Resolved deployment address (no trailing slash), or null when none is configured. */
  baseUrl: string | null;
  token: string | null;
  /** Why the address could not be used, when it was configured but invalid. */
  baseError?: string;
  version: string;
  log: (line: string) => void;
  fetch?: typeof fetch;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

const SIGN_IN = 'Not signed in. Run "artifact-site login --base <url>" or set ARTIFACT_SITE_URL and ARTIFACT_SITE_TOKEN.';

const SHUTTING_DOWN = () => new McpError(ErrorCode.ConnectionClosed, "The local server is shutting down");

/** One remote MCP client, connected on first use. The remote transport is stateless, so once
 *  initialised it stays usable; a failed connection is retried on the next request. close() ends
 *  the client and aborts a handshake still in flight, so nothing outlives the local server. */
class Remote {
  private client: Client | null = null;
  private pending: Promise<Client> | null = null;
  private connecting: AbortController | null = null;
  private closed = false;
  constructor(private readonly o: LocalMcpOptions & { baseUrl: string; token: string }) {}

  get endpoint() { return `${this.o.baseUrl}/mcp`; }

  connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    if (this.closed) return Promise.reject(SHUTTING_DOWN());
    this.pending ??= (async () => {
      const client = new Client({ name: "artifact-site-cli", version: this.o.version });
      const transport = new StreamableHTTPClientTransport(new URL(this.endpoint), {
        requestInit: { headers: { authorization: `Bearer ${this.o.token}`, "user-agent": `artifact-site-cli/${this.o.version} (mcp)` } },
        ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
      });
      const connecting = new AbortController();
      this.connecting = connecting;
      try {
        await client.connect(transport, { timeout: this.o.connectTimeoutMs ?? 15_000, signal: connecting.signal });
        // close() can run between the handshake completing and this line: then this client is closed, not kept.
        if (this.closed) throw SHUTTING_DOWN();
      } catch (error) {
        await client.close().catch(() => {});
        throw error;
      } finally {
        if (this.connecting === connecting) this.connecting = null;
      }
      this.client = client;
      return client;
    })().finally(() => { this.pending = null; });
    return this.pending;
  }

  async close() {
    this.closed = true;
    this.connecting?.abort(SHUTTING_DOWN());
    await this.pending?.catch(() => {});
    await this.client?.close().catch(() => {});
    this.client = null;
  }
}

/** Whether a failure came from the remote server's own JSON-RPC answer (forwarded as it is) rather than from getting there. */
function isRemoteProtocolError(error: unknown): error is McpError {
  return error instanceof McpError && error.code !== ErrorCode.RequestTimeout && error.code !== ErrorCode.ConnectionClosed;
}

/** The body the server sent with an HTTP error. The SDK folds it into its message behind wording of
 *  its own ("Streamable HTTP error: Error POSTing to endpoint: …" today), which is not a contract:
 *  the body is taken from its first "{" on, and the wording is only stripped when the body is not JSON. */
function httpErrorBody(error: StreamableHTTPError): { error?: string; code?: string } {
  const start = error.message.indexOf("{");
  if (start >= 0) {
    try {
      const body = JSON.parse(error.message.slice(start)) as { error?: unknown; code?: unknown };
      return { error: typeof body.error === "string" ? body.error : undefined, code: typeof body.code === "string" ? body.code : undefined };
    } catch { /* not a JSON body */ }
  }
  const text = error.message.replace(/^.*?Error POSTing to endpoint[^:]*:\s*/s, "").trim();
  return { error: text || undefined };
}

/** A person-readable account of why the remote server could not answer. */
export function describeRemoteError(error: unknown, baseUrl: string): string {
  const relogin = `Run "artifact-site login --base ${baseUrl}" again, or set a new ARTIFACT_SITE_TOKEN.`;
  if (error instanceof StreamableHTTPError) {
    const body = httpErrorBody(error);
    if (error.code === 403 && body.code === "insufficient_scope") return body.error ?? error.message;
    if (error.code === 401) return `${baseUrl} rejected the token: it is invalid, expired or revoked. ${relogin}`;
    if (error.code === 403) return `${baseUrl} refused the request${body.error ? ` (${body.error})` : ""}: the token may be invalid or expired. ${relogin}`;
    return `${baseUrl}/mcp answered HTTP ${error.code}${body.error ? `: ${body.error}` : ""}`;
  }
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) return `Timed out waiting for ${baseUrl}/mcp. Check the network and try again.`;
  if (error instanceof McpError && error.code === ErrorCode.ConnectionClosed) return `The connection to ${baseUrl}/mcp closed unexpectedly. Try again.`;
  const e = error as { message?: string; cause?: { code?: string; message?: string } };
  if (e?.cause) return `Cannot reach ${baseUrl}/mcp: ${e.cause.code ?? e.cause.message ?? e.message}`;
  return `Cannot reach ${baseUrl}/mcp: ${e?.message ?? String(error)}`;
}

const toolError = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

/**
 * Build the local server. Connects to the remote first when a credential exists, so its
 * instructions reach the client in `initialize`; an unreachable remote is a warning, not a failure.
 */
export async function createLocalMcpServer(o: LocalMcpOptions): Promise<{ server: Server; close(): Promise<void> }> {
  const bundled = bundledManifest();
  const signedOut = !o.baseUrl ? (o.baseError ? `${o.baseError}. ${SIGN_IN}` : SIGN_IN)
    : !o.token ? `Not signed in to ${o.baseUrl}. Run "artifact-site login --base ${o.baseUrl}" or set ARTIFACT_SITE_TOKEN.`
    : null;
  const remote = signedOut ? null : new Remote(o as LocalMcpOptions & { baseUrl: string; token: string });
  const requestTimeout = o.requestTimeoutMs ?? 120_000;

  let instructions = bundled.instructions;
  if (remote) {
    try {
      instructions = (await remote.connect()).getInstructions() ?? instructions;
      o.log(`artifact-site mcp: forwarding to ${remote.endpoint}`);
    } catch (error) {
      o.log(`artifact-site mcp: warning: ${describeRemoteError(error, o.baseUrl!)} Listing the bundled tools; calls will retry the connection.`);
    }
  } else {
    o.log(`artifact-site mcp: ${signedOut} Listing the bundled tools only.`);
  }

  const server = new Server({ name: "artifact-site", version: o.version }, { capabilities: { tools: {}, resources: {} }, instructions });

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    if (!remote) return { tools: bundled.tools };
    try {
      return await (await remote.connect()).request({ method: "tools/list", params: request.params }, ListToolsResultSchema, { timeout: requestTimeout });
    } catch (error) {
      o.log(`artifact-site mcp: warning: ${describeRemoteError(error, o.baseUrl!)} Listing the bundled tools instead.`);
      return { tools: bundled.tools };
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!remote) return toolError(signedOut!);
    try {
      return await (await remote.connect()).request({ method: "tools/call", params: request.params }, CallToolResultSchema, { timeout: requestTimeout });
    } catch (error) {
      if (isRemoteProtocolError(error)) throw error;
      return toolError(describeRemoteError(error, o.baseUrl!));
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    if (!remote) return { resources: bundled.resources };
    try {
      return await (await remote.connect()).request({ method: "resources/list", params: request.params }, ListResourcesResultSchema, { timeout: requestTimeout });
    } catch (error) {
      o.log(`artifact-site mcp: warning: ${describeRemoteError(error, o.baseUrl!)} Listing the bundled resources instead.`);
      return { resources: bundled.resources };
    }
  });

  // The remote server has no resource templates; answering keeps clients that ask for them quiet.
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (!remote) throw new McpError(ErrorCode.InvalidRequest, signedOut!);
    try {
      return await (await remote.connect()).request({ method: "resources/read", params: request.params }, ReadResourceResultSchema, { timeout: requestTimeout });
    } catch (error) {
      if (isRemoteProtocolError(error)) throw error;
      throw new McpError(ErrorCode.InternalError, describeRemoteError(error, o.baseUrl!));
    }
  });

  return { server, close: async () => { await server.close().catch(() => {}); await remote?.close(); } };
}

/** Serve over the given transport until it closes (stdin ends, or the client disconnects). */
export async function serveMcp(o: LocalMcpOptions, transport: Transport, closed: Promise<void>): Promise<void> {
  const { server, close } = await createLocalMcpServer(o);
  const done = new Promise<void>((resolve) => { server.onclose = resolve; });
  await server.connect(transport);
  await Promise.race([done, closed]);
  await close();
}
