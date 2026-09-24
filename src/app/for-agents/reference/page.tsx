import Link from "next/link";
import { headers } from "next/headers";
import { getT } from "@/lib/i18n-server";
import { resolvePublicBase } from "@/lib/publish-skill";
import { renderGuide } from "@/lib/render-guide";
export default async function GuideReference() {
  const t = await getT();
  const { html } = await renderGuide(resolvePublicBase(await headers()));
  return (
    <div className="guide">
      <Link href="/for-agents">{t("Agent guide")}</Link>
      <h1>{t("Full publishing guide")}</h1>
      <article className="prose" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
