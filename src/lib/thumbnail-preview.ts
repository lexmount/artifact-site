import { parse, serialize, type DefaultTreeAdapterTypes } from "parse5";

const OMIT = new Set(["script", "iframe", "frame", "frameset", "object", "embed"]);

/** Static thumbnail only. The iframe sandbox and response CSP remain the security boundary. */
export function staticThumbnail(html: string): string {
  const document = parse(html, { scriptingEnabled: false });
  const pending: DefaultTreeAdapterTypes.Node[] = [document];
  while (pending.length) {
    const node = pending.pop()!;
    if ("childNodes" in node) {
      node.childNodes = node.childNodes.filter(child => {
        if (!("tagName" in child)) return true;
        if (OMIT.has(child.tagName)) return false;
        const attr = (name: string) => child.attrs.find(a => a.name === name)?.value.toLowerCase() ?? "";
        if (child.tagName === "meta" && attr("http-equiv") === "refresh") return false;
        if (child.tagName === "link" && (attr("rel").split(/\s+/).some(r => ["modulepreload", "prefetch"].includes(r)) || attr("as") === "script")) return false;
        return true;
      });
      for (const child of node.childNodes) pending.push(child);
    }
    if (!("tagName" in node)) continue;
    node.attrs = node.attrs.filter(attr => !/^on/i.test(attr.name) && attr.name !== "srcdoc" &&
      !/^(?:javascript|vbscript):/i.test(attr.value.replace(/[\u0000-\u0020]/g, "")));
    if ("content" in node) pending.push(node.content as DefaultTreeAdapterTypes.Node);
  }
  return serialize(document, { scriptingEnabled: false });
}
