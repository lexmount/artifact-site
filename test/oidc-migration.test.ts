import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { __resetDiscoveryForTests, beginLogin, completeLogin } from "@/lib/oidc";
import { closeDbForTests } from "@/lib/db";

const ISSUER = "https://idp.example/oidc";
const CLIENT_ID = "test-client";
const dirs: string[] = [];

let keys: { privateKey: CryptoKey; publicKey: CryptoKey };
let issuedIdToken: string | null = null;

/** A mock IdP: real RS256 signing + a real JWKS, so jwtVerify does genuine work. */
async function stubIdp(overrides: { issuer?: string } = {}) {
  const jwk = await exportJWK(keys.publicKey);
  jwk.kid = "k1";
  jwk.alg = "RS256";
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return new Response(JSON.stringify({
        issuer: overrides.issuer ?? ISSUER,
        authorization_endpoint: `${ISSUER}/auth`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        end_session_endpoint: `${ISSUER}/session/end`,
      }), { headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/jwks")) {
      return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/token")) {
      return new Response(JSON.stringify({ id_token: issuedIdToken }), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
}

async function mintIdToken(claims: Record<string, unknown>) {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER).setAudience(CLIENT_ID)
    .setIssuedAt().setExpirationTime("5m")
    .sign(keys.privateKey);
}

const req = (cookie?: string) =>
  new Request("https://hub.example/api/auth/callback", { headers: cookie ? { cookie } : {} });

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ah-oidc-"));
  dirs.push(dir);
  process.env.ARTIFACT_DATA_DIR = dir;
  process.env.ARTIFACT_PUBLIC_URL = "https://hub.example";
  process.env.ARTIFACT_OIDC_ISSUER = ISSUER;
  process.env.ARTIFACT_OIDC_CLIENT_ID = CLIENT_ID;
  process.env.ARTIFACT_OIDC_CLIENT_SECRET = "shh";
  keys = await generateKeyPair("RS256");
  __resetDiscoveryForTests();
  await stubIdp();
});

afterEach(async () => {
  await closeDbForTests();
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const k of ["ARTIFACT_DATA_DIR", "ARTIFACT_PUBLIC_URL", "ARTIFACT_OIDC_ISSUER", "ARTIFACT_OIDC_CLIENT_ID", "ARTIFACT_OIDC_CLIENT_SECRET"]) delete process.env[k];
  delete process.env.NEXT_PUBLIC_ARTIFACT_BASE_PATH;
  issuedIdToken = null;
});

describe("subpath login", () => {
  it("uses the configured subpath callback at login and token exchange", async () => {
    const base = "https://new.example/artifact-site";
    process.env.ARTIFACT_PUBLIC_URL = base;
    process.env.NEXT_PUBLIC_ARTIFACT_BASE_PATH = "/artifact-site";
    const {url,cookie} = await beginLogin(new Request(`${base}/api/auth/login`), "/artifact-site/me");
    const params = new URL(url).searchParams;
    expect(params.get("redirect_uri")).toBe(`${base}/api/auth/callback`);
    issuedIdToken = await mintIdToken({sub:"migration-user",nonce:params.get("nonce"),email_verified:true});
    const claims = await completeLogin(new Request(`${base}/api/auth/callback`,{headers:{cookie:cookie.split(";")[0]}}), "code", params.get("state")!);
    expect(claims.returnTo).toBe("/artifact-site/me");
    const calls = vi.mocked(fetch).mock.calls;
    const exchange = calls.find(([url])=>String(url).endsWith("/token"));
    expect(new URLSearchParams(exchange?.[1]?.body as string).get("redirect_uri")).toBe(`${base}/api/auth/callback`);
  });
  it("rejects moving an A login flow to B, even if its cookie is supplied", async () => {
    const base = "https://new.example/artifact-site";
    const {url,cookie} = await beginLogin(req(),"/me");
    process.env.ARTIFACT_PUBLIC_URL = base;
    process.env.NEXT_PUBLIC_ARTIFACT_BASE_PATH = "/artifact-site";
    await expect(completeLogin(new Request(`${base}/api/auth/callback`,{headers:{cookie:cookie.split(";")[0]}}),"code",new URL(url).searchParams.get("state")!)).rejects.toThrow(/callback does not match/);
  });
});
