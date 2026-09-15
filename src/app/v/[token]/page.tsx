import { tenantActive } from "@/lib/rbac-access";
// /v/<token> — the page a READER lands on. The address a share link points at, and the only surface
// on this platform whose visitor may have no account, no anonymous cookie and no prior relationship
// with the site at all.
//
// Read-only, deliberately and completely: no editor, no version history, no share panel, no fork.
// Those affordances all exist on /s/<slug> for people who own the site; a link handed to an outside
// reader must not carry them, and hiding buttons the server would refuse anyway is not the point —
// the point is that this page never offers what it cannot honour.
//
// It also renders with no client JavaScript. The passcode form is a plain <form> posting to
// /api/shares/<token>/unlock, so the one interactive thing here works in a locked-down browser,
// inside a chat client's in-app webview, and with scripts blocked.
import { cache } from "react";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import Link from "next/link";
import { config } from "@/lib/config";
import Assistant from "@/components/assistant";
import { getShareByTokenHash, getSite, getVersion } from "@/lib/db";
import { canReadVersion, canReadSite, hashToken, isLive, logShareView, resolveShareAccess, type ShareDenial } from "@/lib/share";
import { viewerRequestFromHeaders } from "@/lib/authz";
import { resolveSession } from "@/lib/session";
import { anonIdFromRequest } from "@/lib/anon";
import { afterResponse } from "@/lib/after-response";
import { getStorage } from "@/lib/storage";
import { extractDescription } from "@/lib/upload";
import { resolvePublicBase } from "@/lib/publish-skill";
import { getT } from "@/lib/i18n-server";
import type { Translator } from "@/lib/i18n";
import OfficialVersion from "@/components/official-version";
import type { SharePolicy, Site, Version } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Matches /s/[slug]: `<head>` is at the top, and a link-preview scrape must not read a whole
 *  artifact to find a description that may not be there. */
const META_SCAN_BYTES = 64 * 1024;

/**
 * One answer for revoked, expired, never-existed AND site-since-deleted.
 *
 * The undifferentiated wording is the security property, not a shrug: telling a stranger "revoked"
 * confirms the token was real, which turns this page into an oracle for probing which links ever
 * existed and when they stopped working. The owner gets the precise story from GET /shares; the
 * reader gets one sentence.
 *
 * A translation key (rendered through t() at the use site), like every other string on this page.
 */
const DEAD_TITLE = "This link is no longer valid — artifact-site";

/**
 * What a protected link's preview card says.
 *
 * A share card is scraped by whatever chat client the link was pasted into, and that scraper is
 * anonymous — so this copy is shown to everyone the link is forwarded to, invited or not. It
 * therefore describes the DOOR, never the room: enough for the recipient to know what to do next
 * (sign in, ask for an invite, find the code) and nothing about what is inside. Only `public`, which
 * by definition has no gate, lets the artifact describe itself.
 */
const PROTECTED_DESCRIPTION: Record<Exclude<SharePolicy, "public">, string> = {
  login: "Protected content, visible after signing in · artifact-site",
  people: "Protected content, visible to invited members only · artifact-site",
  passcode: "Protected content, passcode required · artifact-site",
};

/**
/** The live site + version behind a share, or null once either is gone. Wrapped in cache() so
 *  generateMetadata and the page — two calls in the same request — share one pair of lookups
 *  (a pass-through outside a request scope, i.e. when tests invoke the page directly). */
const resolveTarget = cache(async (siteId: string, versionId?: string | null): Promise<{ site: Site; version: Version } | null> => {
  const site = await getSite(siteId);
  if (!site || site.deletedAt || site.takenDownAt || !(await tenantActive(site.tenantId)) || !site.currentVersionId) return null;
  const version = await getVersion(versionId || site.currentVersionId);
  return version && version.siteId===site.id ? { site, version } : null;
});

/** The artifact's own `<meta name="description">`, or null. Best-effort: unreadable storage makes
 *  the card plainer, never breaks the page. */
async function artifactDescription(site: Site, version: Version): Promise<string | null> {
  try {
    const bytes = await getStorage().read(site.id, version.id, version.entry);
    return extractDescription(Buffer.from(bytes.slice(0, META_SCAN_BYTES)).toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * The share card.
 *
 * `description` is ALWAYS set — to a string or to an explicit `null`, never omitted. Next merges
 * metadata with the root layout, so an absent key does not mean "no description", it means "inherit
 * the platform's tagline": a colleague opens a link to a quarterly report and the card underneath
 * explains how to drag .zip files in. This repo has shipped that bug twice (see the comment in
 * /s/[slug]/page.tsx, and the not-found boundary's own metadata) — only an explicit null removes it,
 * and `undefined` is the same mistake spelled differently.
 *
 * Deliberately viewer-INDEPENDENT: the card is decided by the share's policy alone, so a scraper,
 * an invited reader and a stranger all get the same one. Making it depend on who is asking would
 * leak the artifact's real description into a preview generated by anyone the link was forwarded to.
 */
export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const [share, t] = await Promise.all([getShareByTokenHash(hashToken(token)), getT()]);
  if (!share || !isLive(share)) return { title: t(DEAD_TITLE), description: null };

  const target = await resolveTarget(share.siteId,share.versionId);
  if (!target) return { title: t(DEAD_TITLE), description: null };

  const title = `${target.site.title} — artifact-site`;
  const description = share.policy === "public"
    ? await artifactDescription(target.site, target.version)
    : t(PROTECTED_DESCRIPTION[share.policy]);

  const url = `${resolvePublicBase(await headers())}/v/${token}`;
  return {
    title,
    description,
    // og:/twitter: descriptions are left unset ON PURPOSE so Next derives them from the resolved
    // top-level one above — neither accepts null, and spelling `undefined` would read as "unset",
    // which inherits. Same reasoning as /s/[slug].
    openGraph: { type: "article", siteName: "artifact-site", title, url },
    twitter: { card: "summary", title },
    alternates: { canonical: url },
    // A protected link should not be indexed even if it leaks into a crawler's queue.
    robots: share.policy === "public" ? undefined : { index: false, follow: false },
  };
}

export default async function SharedViewPage({
  params, searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ e?: string; version?: string }>;
}) {
  const { token } = await params;
  const { e, version: requestedVersion } = await searchParams;

  // Server components get no Request, so rebuild the one the gate AND the view log need — the
  // credentials (session + anonymous id + the passcode grant + scheme), plus the reader's address
  // and agent for logShareView's identity ladder. See viewerRequestFromHeaders.
  const request = viewerRequestFromHeaders(await headers(), `/v/${token}`);
  const [session, t] = await Promise.all([resolveSession(request), getT()]);
  const access = await resolveShareAccess(request, token, { session });

  if (!access.ok) return denied(t, access.reason, token, e);

  request.headers.set("x-artifact-share", token);
  const target = await resolveTarget(access.share.siteId, requestedVersion ?? access.share.versionId);
  // The link is live but the artifact is not. Same undifferentiated answer — from the reader's seat
  // a deleted site and a revoked link are the same event.
  if (!target || !(await canReadVersion(request, target.site, target.version.id, session))) return dead(t);
  // Taken down: the share is live but the site is served to its owner and administrators only.
  if (target.site.takenDownAt && !(await canReadSite(request, target.site, session))) return removed(t);

  // Recorded HERE and nowhere else: one row per opening. Putting it on /api/preview would file a
  // row per asset, so a page with twenty images would look like twenty visits. Best-effort inside,
  // and repeat opens by the same reader collapse for 30 minutes. Deferred past the response —
  // the collapse SELECT + INSERT are bookkeeping the reader should never wait on.
  afterResponse(() => logShareView(request, access.share, session, anonIdFromRequest(request)));

  // Q&A mode: the assistant appears for THIS link's readers only when its owner switched it on —
  // and it carries no edit coordinates (see buildAssistantContext's null-site arm).
  return reader(t, target.site, Boolean(config.assistantUrl && access.share.allowAi), token, requestedVersion ?? access.share.versionId, access.share.mode);
}

// --- surfaces -----------------------------------------------------------------
// Plain functions returning elements rather than nested components: everything a branch renders is
// materialised in one tree, which keeps the copy on this page directly assertable in tests.

/** Shared shell for every non-reading outcome. `.notfound` is already the centred, quiet layout
 *  the app uses when it has nothing to show but a sentence. */
function notice(heading: string, body: ReactNode) {
  return (
    <main className="notfound">
      <h1>{heading}</h1>
      {body}
    </main>
  );
}

function removed(t: Translator) {
  return notice(t("This content has been removed"), (
    <>
      <p>{t("An administrator of this server has taken this site down.")}</p>
      <Link className="btn" href="/">{t("Back to home")}</Link>
    </>
  ));
}

function dead(t: Translator) {
  return notice(t("This link is no longer valid"), (
    <>
      <p>{t("This share link does not exist, has been revoked, or has expired. Ask the person who shared it for a new link.")}</p>
      <Link className="btn" href="/">{t("Back to home")}</Link>
    </>
  ));
}

function denied(t: Translator, reason: ShareDenial, token: string, error?: string) {
  switch (reason) {
    case "notFound":
      return dead(t);

    case "needsLogin": {
      const returnTo = encodeURIComponent(`/v/${token}`);
      return notice(t("Sign in to view"), (
        <>
          <p>{t("The person who shared this link made it visible after signing in. Sign in with your account to open it.")}</p>
          {/* Only offer a login where one can succeed. On a deployment with no IdP configured a
              `login` share is unopenable by anyone, and a button that 400s is worse than a
              sentence explaining why. */}
          {config.oidcEnabled
            ? <a className="btn solid" href={`/api/auth/login?return_to=${returnTo}`}>{t("Sign in")}</a>
            : <p className="drawer-note">{t("This deployment has no sign-in configured yet. Ask the person who shared it for a different link.")}</p>}
        </>
      ));
    }

    case "notInvited":
      return notice(t("Your account is not on this link's access list"), (
        <>
          <p>{t("The person who shared this link limited it to invited members. If you need access, ask them to add you.")}</p>
          <Link className="btn" href="/">{t("Back to home")}</Link>
        </>
      ));

    case "needsPasscode":
    case "wrongPasscode":
      return passcodeForm(t, token, reason === "wrongPasscode" ? "wrong" : error);
  }
}

/** Entry page for a `passcode` share. A real form, posted to a real endpoint — no JS involved. */
function passcodeForm(t: Translator, token: string, error?: string) {
  const message = error === "wrong" ? t("Incorrect passcode. Please try again.")
    : error === "slow" ? t("Too many attempts. Please try again later.")
    : error === "empty" ? t("Please enter the passcode.")
    : null;
  return notice(t("Enter the passcode"), (
    <>
      <p>{t("The person who shared this link protected it with a passcode. Enter it to view; you will not be asked again for 12 hours.")}</p>
      {message && <p className="drawer-error" role="alert">{message}</p>}
      <form className="share-add" method="post" action={`/api/shares/${encodeURIComponent(token)}/unlock`}>
        {/* Not type="password": this is a code someone was told out loud or pasted from a chat, not
            a secret they are trying to hide from the person next to them, and masking it only makes
            it harder to check. autoComplete off for the same reason — nothing here belongs in a
            password manager. */}
        <input
          name="passcode" aria-label={t("Passcode")} autoComplete="off" autoFocus
          maxLength={64} required placeholder={t("Passcode")}
        />
        <button className="btn solid" type="submit">{t("View")}</button>
      </form>
    </>
  ));
}

/** The artifact itself, full-bleed under a bar that offers reading and nothing else. */
function reader(t: Translator, site: Site, assistant = false, token = "", versionId: string | null = null, mode = "view") {
  return (
    // Same full-screen stage as /s/<slug>, minus every control. `data-bar="open"` is static here:
    // the collapsing behaviour over there is driven by JavaScript, and this page has none — so the
    // bar simply stays put and the artifact sits below it. (The one exception: an allow_ai share
    // mounts the assistant in Q&A mode below, which brings its own script; the default page stays JS-free.)
    <div className="fs-viewer" data-device="desktop" data-bar="open">
      <div className="fs-stage-wrap">
        <div className="fs-stage">
          {/* Never allow-same-origin: the artifact is untrusted code, and the served HTML carries
              its own sandbox CSP. Identical to the viewer's iframe on purpose — a reader must not
              get a laxer sandbox than the owner does. */}
          <iframe
            className="fs-frame"
            src={`/api/preview/${site.slug}?share=${encodeURIComponent(token)}${versionId ? `&v=${encodeURIComponent(versionId)}` : ""}`}
            title={site.title}
            sandbox="allow-forms allow-modals allow-scripts allow-popups allow-downloads"
            allow="fullscreen"
          />
        </div>
      </div>

      <div className="fs-chrome is-open">
        <header className="app-header fs-bar" aria-label={t("Shared output")}>
          <div className="fs-bar-glass" aria-hidden="true" />
          <Link className="brand" href="/" aria-label={t("artifact-site home")}>
            <span aria-hidden="true">←</span>
            <b>artifact-site</b>
          </Link>
          <div className="header-mid">
            <span className="header-title" title={site.title}>{site.title}</span>
            <div className="viewer-meta">
              <span className="kind-chip">{site.kind === "single" ? t("Single file") : site.kind === "document" ? t("Document") : t("Folder")}</span>
              <span className="dot" aria-hidden="true" />
              <span>{t(mode === "edit" ? "Editable share" : mode === "comment" ? "Comment access reserved" : "Read-only share")}</span>
            </div>
          </div>
          <div className="controls">
            {mode === "edit" && <Link className="btn" href={`/s/${site.slug}/edit?share=${encodeURIComponent(token)}${versionId ? `&version=${encodeURIComponent(versionId)}` : ""}`}>{t("Edit")}</Link>}
            {/* Unpinned: a share is a window onto whatever is CURRENT. Naming a version here would
                quietly freeze the link at the moment it was opened, and the reader has no history
                to navigate back out of it — that is the owner's surface, not this one. */}
            <a className="btn sm ghost" href={`/api/preview/${site.slug}?share=${encodeURIComponent(token)}${versionId ? `&v=${encodeURIComponent(versionId)}` : ""}`} target="_blank" rel="noreferrer">
              {t("Open in a new tab")}
            </a>
          </div>
          <OfficialVersion slug={site.slug} versionId={versionId ?? site.currentVersionId} share={token} />
        </header>
      </div>
      {assistant && <Assistant sdkBase={config.assistantUrl} slug={site.slug} mode="qa" />}
    </div>
  );
}
