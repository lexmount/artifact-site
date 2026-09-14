import Link from "next/link";
// Home — the product's face, in this order: what it is and the one thing to do (upload), the
// agent's one line, then sites. Server component: reads the site list straight from the store,
// then hands it to client islands.
//
// `listSites()` is every site this VIEWER may see listed, not "mine" — the browser derives
// "recently viewed" FROM this list. Why the viewer is resolved here at all: the list hides
// unlisted sites, and handing down the bare public directory would hide your own unlisted site
// from your own recent shelf. So the query gets the viewer, and the exception stays server-side.
import { headers } from "next/headers";
import type { ReactNode } from "react";
import AppShell from "@/components/app-shell";
import Uploader from "@/components/uploader";
import HeroMotion from "@/components/hero-motion";
import CommandBlock from "@/components/command-block";
import BookmarkletLink from "@/components/bookmarklet-link";
import HomeRecent from "@/components/home-recent";
import { listSites, listViewerFromRequest } from "@/lib/sites";
import { resolvePublicBase } from "@/lib/publish-skill";
import { forwardedProto } from "@/lib/http";
import { getT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

/** The one word in the title that carries the green: translations place it wherever their grammar puts it. */
const SLOT = "\u0000";
function slot(text: string, node: ReactNode): ReactNode {
  const [before, after] = text.split(SLOT);
  return <>{before}{node}{after}</>;
}

export default async function Home() {
  const t = await getT();
  // A server component has headers, not a Request, and both cookie readers key off the scheme
  // (`__Host-` on https, the bare name on plain-http dev). Next fills in x-forwarded-proto, so the
  // synthesized URL carries the real scheme instead of guessing one and missing the cookie.
  const h = await headers();
  const proto = forwardedProto(h) === "https" ? "https" : "http";
  const viewer = await listViewerFromRequest(
    new Request(`${proto}://x/`, { headers: { cookie: h.get("cookie") ?? "" } }),
  );
  const sites = await listSites(viewer);
  // The AI entry hands out THIS deployment's own address, same resolution as /for-agents(.md).
  const base = resolvePublicBase(h);

  return (
    <AppShell>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyeline">{t("Upload, and it is online")}</p>
          {/* Two lines on purpose: the first is what you bring, the second what it becomes. */}
          <h1>{t("Turn your work")}<br />{slot(t("into a {link} to share and collaborate.", { link: SLOT }), <span className="hl">{t("link")}</span>)}</h1>
          <p className="deck">{t("HTML, folders, PDFs and Office documents all become shareable links.")}</p>
          <Uploader compact />
        </div>
        <HeroMotion />
      </section>

      <section className="agent-prompt" aria-label={t("Let an AI publish")}>
        <p>{t("Or let an agent publish it for you")}</p>
        <CommandBlock command={t("Publish this project's output (a web page or a PDF/Office document) to artifact-site. Publishing guide: {url}", { url: `${base}/for-agents.md` })} />
        <Link className="agent-connect-link" href="/for-agents#cli">{t("CLI / MCP connection →")}</Link>
        <BookmarkletLink />
      </section>

      <HomeRecent allSites={sites} />
    </AppShell>
  );
}
