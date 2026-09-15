// GET /oauth/jwks — the key set the OpenID-shaped discovery document points at. Empty: every token
// this server issues is opaque and validated by lookup, never by signature.
import { discoveryPreflight, discoveryResponse } from "@/lib/oauth-shared";

export function GET(): Response {
  return discoveryResponse({ keys: [] });
}

export function OPTIONS(): Response {
  return discoveryPreflight();
}
