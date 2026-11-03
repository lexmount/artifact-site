import type { Translator } from "@/lib/i18n";

/** One entry prompt for the homepage and connection guide, including mounted deployments. */
export function agentPrompt(base: string, t: Translator): string {
  return t("Read {url} and help me host and share artifacts with artifact-site. First use this conversation to identify what I want to host; if it is not clear, ask me what I have or would like to create. If authorization is needed, show me the authorization link and continue the requested task after I approve.", { url: `${base.replace(/\/$/, "")}/for-agents.md` });
}
