import type { Translator } from "@/lib/i18n";
import type { CommentAnchor } from "./contracts";

/** Display-only excerpt; preserve original evidence and anchors for locating the comment. */
export function commentQuote(text: string): string {
  const characters = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text.replace(/\s+/g, " ").trim()), part => part.segment);
  return characters.slice(0, 30).join("") + (characters.length > 30 ? "…" : "");
}

export function commentAnchorLabel(anchor: CommentAnchor, excerpt: string | null | undefined, t: Translator): string {
  const quote = excerpt ? commentQuote(excerpt) : "";
  if (anchor.kind === "document") return t("Comment on the whole file") + (quote ? ` · ${quote}` : "");
  return quote || (anchor.kind === "pdf" ? t("Page {page}", { page: anchor.page }) : anchor.filePath);
}
