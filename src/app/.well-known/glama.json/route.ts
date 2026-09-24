// GET /.well-known/glama.json — proves to Glama (glama.ai/mcp/connectors) that whoever runs this
// origin owns its MCP connector listing. Only served when the operator sets ARTIFACT_GLAMA_CLAIM.
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

export function GET(): Response {
  const claim = config.glamaClaim;
  if (!claim) return new Response("Not found", { status: 404 });
  return Response.json(
    { $schema: "https://glama.ai/mcp/schemas/connector.json", claim },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
