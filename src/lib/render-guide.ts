import "server-only";
import { marked } from "marked";
import { parseSkill } from "@/lib/publish-skill";
// Bounded by validated origin; a Host variation cannot grow the process indefinitely.
const rendered = new Map<string, Promise<{ html: string; name: string }>>();
export function renderGuide(base: string) {
  let value = rendered.get(base);
  if (!value) {
    const { body, meta } = parseSkill(base);
    value = Promise.resolve(marked.parse(body))
      .then((html) => ({ html, name: meta.name ?? "" }))
      .catch((error) => {
        rendered.delete(base);
        throw error;
      });
    if (rendered.size >= 8) rendered.delete(rendered.keys().next().value!);
    rendered.set(base, value);
  }
  return value;
}
