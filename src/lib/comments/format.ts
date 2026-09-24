/** Deliberately small text grammar: no HTML, images, embeds or arbitrary URL schemes. */
export type CommentTextPart = ({ kind: "text" | "code"; text: string } | { kind: "link"; text: string; href: string }) & {start?: number};
export function safeCommentLink(value: string): string | null {
  if (/[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function commentTextParts(body: string, withOffsets = false): CommentTextPart[] {
  const parts: CommentTextPart[] = [];
  const append = (part: CommentTextPart, start: number) => parts.push(withOffsets ? {...part,start} : part);
  const pattern = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^\s)]+)\)|(https?:\/\/[^\s<>`]+)/g;
  let start = 0;
  for (const match of body.matchAll(pattern)) {
    if (match.index! > start) append({kind:"text",text:body.slice(start,match.index)},start);
    if (match[1]) append({kind:"code",text:match[1]},match.index!+1);
    else {
      const raw = match[3] ?? match[4];
      const target = match[4] ? raw.replace(/[.,!?;:，。！？；：]+$/, "") : raw;
      const href = safeCommentLink(target);
      append(href ? {kind:"link",text:match[2] ?? target,href} : {kind:"text",text:match[0]},match.index!+(href && match[2] ? 1:0));
      if (href && target.length < raw.length) append({kind:"text",text:raw.slice(target.length)},match.index!+target.length);
    }
    start = match.index! + match[0].length;
  }
  if (start < body.length) append({kind:"text",text:body.slice(start)},start);
  return parts;
}
