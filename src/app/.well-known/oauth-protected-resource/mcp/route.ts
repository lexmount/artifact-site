// GET /.well-known/oauth-protected-resource/mcp — the path-suffixed form of RFC 9728 metadata
// (the MCP endpoint is /mcp, not the origin), which is the address /mcp's 401 challenge names.
import { discoveryPreflight, discoveryResponse, issuerFor, protectedResourceMetadata } from "@/lib/oauth-shared";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return discoveryResponse(protectedResourceMetadata(issuerFor(request)));
}

export function OPTIONS(): Response {
  return discoveryPreflight();
}
