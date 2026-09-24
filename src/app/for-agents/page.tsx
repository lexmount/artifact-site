// /for-agents — the human-facing page for the agent route. First screen: one sentence, the line
// to hand to an agent, three steps. Below the fold: the machine guide (/for-agents.md) rendered
// in full, and the skill metadata, so nothing that was here before is gone.
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import AppShell from "@/components/app-shell";
import AgentConnectionGuide from "@/components/agent-connection-guide";
import { config } from "@/lib/config";
import GuideLinks from "@/components/guide-links";
import { resolvePublicBase } from "@/lib/publish-skill";
import { policy } from "@/lib/settings";
import { getLocale, getT } from "@/lib/i18n-server";
import { marketingMetadata } from "@/lib/marketing-metadata";

export const dynamic = "force-dynamic"; // the copy-me skill URL is derived from the request Host.

export async function generateMetadata(): Promise<Metadata> {
  const [h, locale, t] = await Promise.all([headers(), getLocale(), getT()]);
  return marketingMetadata({
    base: resolvePublicBase(h),
    path: "/for-agents",
    locale,
    title: t("Publish skill — for AI / agents"),
    description: t("Send one address to your AI and it can publish front-end output as a link you can share and edit in place."),
  });
}

export default async function PublishGuide() {
  const t = await getT();
  const base = resolvePublicBase(await headers());
  const skillUrl = `${base}/for-agents.md`;
  return (
    <AppShell>
      <div className="guide">
        <h1>{t("Let agents publish, find and update work")}</h1>
        <p className="intro">{t("Choose one way to connect the tools you already use.")}</p>
        <AgentConnectionGuide base={base} oidcEnabled={config.oidcEnabled} dcrEnabled={policy.oauth.dcrEnabled} />
        <GuideLinks
          links={[{ id: "connection-help", label: t("Authentication and troubleshooting ↓") }, { id: "full-guide", label: t("Full publishing guide ↓") }, { id: "file-limits", label: t("Supported files and limits ↓") }]}
          external={{ href: skillUrl, label: t("Machine-readable guide ↗") }}
        />
        <details id="connection-help">
          <summary>{t("Authentication and troubleshooting")}</summary>
          <p>{t("CLI and remote MCP use the same Bearer credentials and account permissions. Configure each client separately. Operator tokens have broad privileges; remote MCP requires authentication for every request.")}</p>
          <p>{t("In CLI, an environment token overrides a saved token. Check the server address and stale ARTIFACT_SITE_TOKEN when authentication fails. CLI logout removes local credentials; revoke a personal token in My sites to stop its use by every client.")}</p>
          <p>{t("A cloud agent cannot reach localhost on your computer. Use a server address reachable from the agent. The browser cannot detect whether the CLI is installed or connected on another machine.")}</p>
          <p>{t("CLI and MCP create public shares by default when publishing. Use --share none in the CLI or share: false in MCP to keep new work unshared; existing site visibility and sharing rules still apply.")}</p>
        </details>
        <details id="file-limits">
          <summary>{t("Supported files and limits")}</summary>
          <p>{t("HTML, folders, ZIP, PDF and Office documents. Sizes, formats and what a hosted page may do at runtime are set out in the full guide below.")}</p>
        </details>
        <p id="full-guide"><Link prefetch={false} href="/for-agents/reference">{t("Full publishing guide")} →</Link></p>
      </div>
    </AppShell>
  );
}
