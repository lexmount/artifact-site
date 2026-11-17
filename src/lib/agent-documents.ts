import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { resolvePublicBase } from "@/lib/publish-skill";

const documents = {
  agents: { file: "agent-instructions.md", type: "text/markdown" },
  index: { file: "llms.txt", type: "text/plain" },
} as const;
const sources = new Map<string, string>();

/** Public service instructions, separate from the repository's contributor AGENTS.md. */
export function agentDocumentResponse(document: keyof typeof documents, request: Request): Response {
  const { file, type } = documents[document];
  let source = sources.get(file);
  if (source === undefined) {
    source = readFileSync(path.join(process.cwd(), "src/content", file), "utf8");
    sources.set(file, source);
  }
  const body = source.split("{{BASE_URL}}").join(resolvePublicBase(request.headers));
  return new Response(body, {
    headers: {
      "content-type": `${type}; charset=utf-8`,
      "cache-control": "public, max-age=3600",
      vary: "Host, X-Forwarded-Proto",
    },
  });
}
