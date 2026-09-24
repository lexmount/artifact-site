/** Render only text nodes: feedback and the query are both untrusted. */
export function CommentHighlight({text, query = ""}: {text: string; query?: string}) {
  const term = query.trim();
  if (!term) return <>{text}</>;
  const pattern = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "giu");
  return <>{text.split(pattern).map((part, index) => index % 2
    ? <mark className="comment-match" key={index}>{part}</mark> : part)}</>;
}
