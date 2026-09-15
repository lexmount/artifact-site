// /oauth/authorize — the consent page of this server's OAuth authorization server (lib/oauth).
//
// An MCP client (ChatGPT, Claude, …) sends the person here. The request is validated first — the
// client and the address it wants to be sent back to above all, so nothing can be redirected
// anywhere unregistered — then the person signs in if they have not, and finally sees who is
// asking, for what, and as whom, with one form that answers exactly once (POST /oauth/decision).
//
// Server-rendered on purpose: the page must work with scripts off, and the one thing it does is
// show a decision and submit it. The one real risk is social — someone sending a victim a link
// that authorizes THEIR connection — so the application's name and host, the return address and
// the account are all spelled out before the button.
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import AppShell from "@/components/app-shell";
import { viewerRequestFromHeaders } from "@/lib/authz";
import { getUser } from "@/lib/db";
import { getT } from "@/lib/i18n-server";
import { prepareAuthorization, type AuthorizationOutcome } from "@/lib/oauth";
import { issuerFromHeaders, SCOPE_READ, SCOPE_WRITE } from "@/lib/oauth-shared";
import { checkRateLimit, RateLimitError } from "@/lib/ratelimit";
import { resolveSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  // Every page ships `Referrer-Policy: no-referrer` (next.config), and under that policy browsers
  // send `Origin: null` on a plain form POST — which the decision route rightly refuses as
  // cross-site. This page overrides the policy for itself: its address carries nothing secret
  // (a client id, a PKCE challenge, the client's own state), and `same-origin` still sends no
  // referrer anywhere else. With it, the consent form's POST carries this site's real Origin.
  return { title: t("Connect an application"), referrer: "same-origin" };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const t = await getT();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) if (typeof value === "string") params.set(key, value);
  const bag = await headers();
  // viewerRequestFromHeaders, not requestFromHeaders: the rate limiter keys on the address headers.
  const request = viewerRequestFromHeaders(bag, "/oauth/authorize");
  const session = await resolveSession(request);
  // The SAME issuer rule as every route (issuerFor): the resource stored here is what the token
  // endpoint binds tokens to and what /mcp compares against, so the two may not disagree.
  const issuer = issuerFromHeaders(bag);
  let outcome: AuthorizationOutcome;
  if (!issuer) {
    outcome = { kind: "invalid", title: "Sign-in is not configured", message: "This server cannot tell which address it is reached at; set ARTIFACT_PUBLIC_URL." };
  } else {
    try {
      // Every visit by a signed-in person writes a pending-consent row: the address budget and a
      // per-account one keep a loop, or a script, from filling the table.
      checkRateLimit(request);
      if (session) checkRateLimit(request, undefined, `oauth-consent:${session.userId}`);
      outcome = await prepareAuthorization(params, session, issuer);
    } catch (error) {
      if (!(error instanceof RateLimitError)) throw error;
      outcome = { kind: "invalid", title: "Too many requests", message: "Too many authorization requests in a short time. Wait a minute, then start again from the application." };
    }
  }
  if (outcome.kind === "redirect") redirect(outcome.location);
  if (outcome.kind === "login") redirect(`/api/auth/login?return_to=${encodeURIComponent(`/oauth/authorize?${params.toString()}`)}`);

  if (outcome.kind === "invalid") {
    return (
      <AppShell>
        <div className="home tight">
          <section className="narrow-hero">
            <p className="eyebrow">{t("Connect an application")}</p>
            <h1>{t(outcome.title)}</h1>
            <p className="deck">{t(outcome.message)}</p>
            <Link className="primary" href="/">{t("Back to home")}</Link>
          </section>
        </div>
      </AppShell>
    );
  }

  const user = session ? await getUser(session.userId) : null;
  const who = user?.displayName || user?.email || t("your account");
  const clientHost = hostOf(outcome.client.id);
  // Three kinds of return address, each named for what it is: a web host, a listener on this
  // computer (plain http is only ever accepted on the loopback host), or a native app's own scheme.
  const returnUrl = new URL(outcome.redirectUri);
  const web = returnUrl.protocol === "https:" || returnUrl.protocol === "http:";
  const returnHost = web ? returnUrl.host : `${returnUrl.protocol}//${returnUrl.host}`;
  const loopback = returnUrl.protocol === "http:";
  const nativeApp = !web;
  const scopeText: Record<string, string> = {
    [SCOPE_READ]: t("Read: find, open and export your artifacts"),
    [SCOPE_WRITE]: t("Change: publish new artifacts; update, share, roll back and delete existing ones"),
  };

  return (
    <AppShell>
      <div className="home tight">
        <section className="narrow-hero">
          <p className="eyebrow">{t("Connect an application")}</p>
          <h1>{t("Allow {app} to use your artifacts?", { app: outcome.client.name })}</h1>
          <p className="deck">
            {t("{app} ({host}) wants to work with the artifacts of {name} on this server. It gets exactly what is listed below, until you disconnect it from My sites.", { app: outcome.client.name, host: outcome.client.kind === "metadata-document" ? clientHost : t("registered application"), name: who })}
          </p>
          <ul className="consent-scopes">
            {outcome.scopes.map((scope) => <li key={scope}>{scopeText[scope] ?? scope}</li>)}
          </ul>
          <p className="deck">
            {t("After you decide you will be sent back to {host}.", { host: returnHost })}{" "}
            {loopback && <b>{t("That address is on your own computer: continue only if you started this connection yourself.")}</b>}
            {nativeApp && <b>{t("That address opens an application on your computer: continue only if you started this connection yourself.")}</b>}
            {!loopback && !nativeApp && <b>{t("Only allow connections you started yourself; never approve a request someone else sent you.")}</b>}
          </p>
          <form method="post" action="/oauth/decision" className="consent-actions">
            <input type="hidden" name="request" value={outcome.requestId} />
            <button type="submit" name="decision" value="allow" className="primary">{t("Allow")}</button>
            <button type="submit" name="decision" value="deny" className="btn">{t("Deny")}</button>
          </form>
        </section>
      </div>
    </AppShell>
  );
}
