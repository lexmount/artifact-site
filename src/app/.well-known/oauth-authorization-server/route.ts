// GET /.well-known/oauth-authorization-server — RFC 8414: this server's own OAuth endpoints and
// capabilities (PKCE S256, metadata-document clients, dynamic registration), for MCP clients.
import { authorizationServerMetadata, discoveryPreflight, discoveryResponse, issuerFor } from "@/lib/oauth-shared";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return discoveryResponse(authorizationServerMetadata(issuerFor(request), "oauth"));
}

export function OPTIONS(): Response {
  return discoveryPreflight();
}
