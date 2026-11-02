import { parse, serialize, type DefaultTreeAdapterTypes } from "parse5";
import { safeRelativePath } from "@/lib/storage";
const origin = "https://package.invalid";

/** Resolve local references inside the immutable package namespace, never at platform routes. */
export function packageReference(value: string, base: string, root: string): string {
  const input = value.trim();
  if (!input || input.startsWith("#") || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(input)) return value;
  try {
    const url = new URL(input.startsWith("/") ? root + input.slice(1) : input, origin + base);
    if (!url.pathname.startsWith(root)) return "about:blank";
    const relative = decodeURIComponent(url.pathname.slice(root.length));
    if (relative) safeRelativePath(relative.replace(/\/$/, ""), "package");
    return url.pathname + url.search + url.hash;
  } catch { return "about:blank"; }
}
export function packageCss(css: string, base: string, root: string): string {
  return css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi, (_, double: string | undefined, single: string | undefined, bare: string) => {
    const quote = double !== undefined ? '"' : single !== undefined ? "'" : "";
    return `url(${quote}${packageReference(double ?? single ?? bare, base, root)}${quote})`;
  })
    .replace(/(@import\s+)(["'])([^"']+)\2/gi, (_, prefix: string, quote: string, value: string) => `${prefix}${quote}${packageReference(value, base, root)}${quote}`);
}
/** Candidate URLs may contain commas (notably data URLs); split after descriptors instead. */
function packageSrcset(value: string, base: string, root: string): string {
  const candidates: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    while (/[\s,]/.test(value[offset] ?? "") && offset < value.length) offset++;
    const start = offset;
    while (offset < value.length && !/\s/.test(value[offset])) offset++;
    let url = value.slice(start, offset);
    if (!url) break;
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
      candidates.push(packageReference(url, base, root));
      continue;
    }
    const descriptorStart = offset;
    let parentheses = 0;
    while (offset < value.length) {
      const char = value[offset];
      if (char === "," && parentheses === 0) break;
      if (char === "(") parentheses++;
      if (char === ")") parentheses = Math.max(0, parentheses - 1);
      offset++;
    }
    candidates.push(packageReference(url, base, root) + value.slice(descriptorStart, offset).trimEnd());
    if (value[offset] === ",") offset++;
  }
  return candidates.join(", ");
}
export function packageHtml(html: string, file: string, root: string): { html: string; base: string } {
  let base = root + file.split("/").slice(0, -1).map(encodeURIComponent).join("/") + (file.includes("/") ? "/" : "");
  const document = parse(html);
  const nodes: DefaultTreeAdapterTypes.Node[] = [], pending: DefaultTreeAdapterTypes.Node[] = [document];
  while (pending.length) {
    const node = pending.pop()!; nodes.push(node);
    if ("childNodes" in node) pending.push(...[...node.childNodes].reverse());
  }
  const authoredBase = nodes.find(n => "tagName" in n && n.tagName === "base");
  if (authoredBase && "attrs" in authoredBase) {
    const href = authoredBase.attrs.find(a => a.name === "href")?.value;
    if (href) { const resolved = packageReference(href, base, root); if (resolved.startsWith(root)) base = resolved; }
  }
  for (const node of nodes) {
    if (!("tagName" in node)) continue;
    for (const attr of node.attrs) {
      if (["src", "href", "poster", "action", "formaction", "data"].includes(attr.name)) attr.value = packageReference(attr.value, base, root);
      if (attr.name === "srcset" || attr.name === "imagesrcset") attr.value = packageSrcset(attr.value, base, root);
      if (attr.name === "style") attr.value = packageCss(attr.value, base, root);
    }
    if (node.tagName === "style") for (const text of node.childNodes) if ("value" in text) text.value = packageCss(text.value, base, root);
  }
  return { html: serialize(document), base };
}
