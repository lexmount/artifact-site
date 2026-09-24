// The CLI's local MCP server (`artifact-site mcp`) lists cli/src/mcp-tools.json when it is not signed
// in — that is what MCP directories inspect. The file is generated from this server's own
// registrations; this test regenerates it and fails when the committed copy has drifted.
//   npm run generate:mcp-tools     rewrite cli/src/mcp-tools.json
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRemoteMcpServer } from "@/lib/mcp/server";
import { mcpTools } from "@/lib/mcp-tools";

const FILE = "cli/src/mcp-tools.json";

async function generate(): Promise<string> {
  const server = createRemoteMcpServer(new Request("http://localhost/mcp"));
  const client = new Client({ name: "manifest", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const { tools } = await client.listTools();
    const { resources } = await client.listResources();
    const manifest = {
      instructions: client.getInstructions() ?? "",
      tools: tools.map(({ name, title, description, inputSchema, outputSchema, annotations }) => ({ name, title, description, inputSchema, ...(outputSchema ? { outputSchema } : {}), annotations })),
      resources,
    };
    return JSON.stringify(manifest, null, 2) + "\n";
  } finally { await client.close(); await server.close(); }
}

it("cli/src/mcp-tools.json matches the tools this server registers", async () => {
  const fresh = await generate();
  if (process.env.UPDATE_MCP_TOOLS) writeFileSync(FILE, fresh);
  const committed = readFileSync(FILE, "utf8");
  expect(committed === fresh, `${FILE} is out of date with src/lib/mcp/server.ts: run "npm run generate:mcp-tools" and commit the result`).toBe(true);
  expect(JSON.parse(committed).tools.map((t: { name: string }) => t.name).sort()).toEqual(mcpTools.map(([name]) => name).sort());
});
