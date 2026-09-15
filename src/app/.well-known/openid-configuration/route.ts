// GET /.well-known/openid-configuration — the same authorization-server document in the shape of
// OpenID Connect Discovery, for clients that only try this address (the MCP spec makes them try
// both). This server issues no ID tokens; the OpenID-specific fields exist so the document parses.
import { authorizationServerMetadata, discoveryPreflight, discoveryResponse, issuerFor } from "@/lib/oauth-shared";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return discoveryResponse(authorizationServerMetadata(issuerFor(request), "openid"));
}

export function OPTIONS(): Response {
  return discoveryPreflight();
}
