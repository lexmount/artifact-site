// GET /for-agents.md — the publish skill as raw markdown: the one address you hand an AI / agent.
//
// Served with the frontmatter intact, so an agent can save the response as SKILL.md and install it,
// or just follow it inline. The base URL inside is rewritten to THIS deployment's origin, so a
// self-hosted instance hands out its own address rather than the one baked into the committed file.
// Humans get the rendered version, from the same source and the same base, at /for-agents.
import { getSkillForBase, getSkillVersion, resolvePublicBase, SKILL_VERSION_HEADER } from "@/lib/publish-skill";

// The body depends on the resolved origin, which may come from the request's Host — never prerender.
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return new Response(getSkillForBase(resolvePublicBase(request.headers)), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=3600",
      // The same value the API stamps on every response; an agent compares the two to know its copy is stale.
      [SKILL_VERSION_HEADER]: getSkillVersion(),
      // Only bites a deployment that has NOT set ARTIFACT_PUBLIC_URL (there the base comes from
      // Host and the external scheme). A shared cache must not mix their generated API addresses.
      // With PUBLIC_URL set the body is constant anyway.
      vary: "Host, X-Forwarded-Proto",
    },
  });
}
