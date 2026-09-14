// The IdP redirect target's behaviour, shared by every path we expose it on. Which of those paths
// is actually advertised to the IdP is config.oidcRedirectPath; the handler itself is identical on
// all of them, so an alias can never be a weaker door than the canonical one.
import { NextResponse } from "next/server";
import { adoptAnonymousSites, upsertUser } from "@/lib/db";
import { clearFlowCookie, completeLogin, OidcError } from "@/lib/oidc";
import { mintSession } from "@/lib/session";
import { anonIdFromRequest } from "@/lib/anon";
import { config } from "@/lib/config";

export async function handleOidcCallback(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const claims = await completeLogin(request, params.get("code") ?? "", params.get("state") ?? "");

  // Keyed on (provider, subject) only — never the email, which an attacker could pre-register.
  const user = await upsertUser({
    authProvider: "oidc",
    providerSubject: claims.subject,
    email: claims.email,
    emailVerified: claims.emailVerified,
    displayName: claims.displayName,
    avatarUrl: claims.avatarUrl,
  });

  // A disabled account is refused here, before a session exists. The reason is shown: the person
  // has to understand what happened, and an administrator wrote it for exactly this screen.
  if (user.disabledAt) {
    throw new OidcError(`This account has been disabled by an administrator${user.disabledReason ? `: ${user.disabledReason}` : ""}.`, 403);
  }

  // Everything this browser made anonymously now belongs to the account. One statement, and it
  // only touches rows still unowned — a site already claimed by someone is never pulled away.
  const anonId = anonIdFromRequest(request);
  const adopted = anonId ? await adoptAnonymousSites(anonId, user.id) : 0;

  const { cookie } = await mintSession(request, user.id, {
    oidcSid: claims.sid,
    ip: request.headers.get("x-real-ip"),
    userAgent: request.headers.get("user-agent"),
  });

  // Carry the adoption count home so the UI can acknowledge what just changed. It is a hint for
  // a transition, never an authorization input — the client strips it from the URL on arrival.
  const base = config.publicUrl || new URL(request.url).origin;
  const dest = new URL(`${base}${claims.returnTo}`);
  dest.searchParams.set("welcome", String(adopted));
  const res = NextResponse.redirect(dest.toString(), 302);
  res.headers.append("set-cookie", cookie);
  res.headers.append("set-cookie", clearFlowCookie(request)); // one-shot: burn it either way
  return res;
}

/**
 * The callback is a BROWSER navigation, not an API call: a failure answered with bare JSON reads
 * as a broken site. This renders the one thing a person stuck mid-login needs — what happened, in
 * one sentence, and a way to try again. OidcError messages are our own copy (safe, actionable);
 * anything else is summarised rather than echoed, then logged server-side.
 */
export function oidcFailureResponse(error: unknown): NextResponse {
  const status = error instanceof OidcError ? error.statusCode : 500;
  if (!(error instanceof OidcError)) console.error("[oidc-callback]", error);
  const message = error instanceof OidcError ? error.message : "Something went wrong during sign-in. Please try again.";
  const safe = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign-in failed — artifact-site</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100vh;font:400 15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:#fdfdfd;color:#171a17}
main{max-width:26rem;padding:2rem}h1{font-size:1.4rem;font-weight:600;margin:0 0 .6rem}p{margin:0 0 1.2rem;color:#626862}
a{display:inline-block;margin-right:.8rem;padding:.55rem .9rem;border:1px solid #e3e7e1;border-radius:7px;color:#171a17;text-decoration:none;font-weight:500;font-size:.9rem}
a.primary{background:#171a17;border-color:#171a17;color:#fff}</style></head>
<body><main><h1>Sign-in did not complete</h1><p>${safe}</p>
<a class="primary" href="/api/auth/login?return_to=%2F">Sign in again</a><a href="/">Back to home</a></main></body></html>`;
  return new NextResponse(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
