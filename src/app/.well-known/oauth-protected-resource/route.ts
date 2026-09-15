// GET /.well-known/oauth-protected-resource — RFC 9728: where /mcp's authorization server is.
// The root form; MCP clients try the path-suffixed one (…/mcp, next to this file) first.
import { discoveryPreflight, discoveryResponse, issuerFor, protectedResourceMetadata } from "@/lib/oauth-shared";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return discoveryResponse(protectedResourceMetadata(issuerFor(request)));
}

export function OPTIONS(): Response {
  return discoveryPreflight();
}
