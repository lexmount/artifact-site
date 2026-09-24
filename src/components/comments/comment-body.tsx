import type { CommentMention } from "@/lib/comments/mention-types";
import { CommentHighlight } from "./comment-highlight";
import { commentTextParts } from "@/lib/comments/format";

export function CommentBody({
  body,
  format,
  query,
  mentions = [],
}: {
  body: string;
  format?: "plain" | "lightweight";
  query?: string;
  mentions?: CommentMention[];
}) {
  const parts =
    format === "lightweight"
      ? commentTextParts(body, true)
      : [{ kind: "text" as const, text: body, start: 0 }];
  return (
    <>
      {parts.map((part, index) => {
        const start = part.start ?? 0;
        let cursor = 0;
        const content = [];
        for (const mention of [...mentions].sort((a, b) => a.start - b.start)) {
          const from = mention.start - start,
            to = mention.end - start;
          if (
            from < cursor ||
            to > part.text.length ||
            part.text.slice(from, to) !== "@" + mention.label
          )
            continue;
          content.push(
            <CommentHighlight
              key={"text" + cursor}
              text={part.text.slice(cursor, from)}
              query={query}
            />,
          );
          content.push(
            <span className="comment-mention" key={"mention" + from}>
              <CommentHighlight
                text={part.text.slice(from, to)}
                query={query}
              />
            </span>,
          );
          cursor = to;
        }
        content.push(
          <CommentHighlight
            key={"tail" + cursor}
            text={part.text.slice(cursor)}
            query={query}
          />,
        );
        return part.kind === "code" ? (
          <code key={index}>{content}</code>
        ) : part.kind === "link" ? (
          <a
            key={index}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            {content}
          </a>
        ) : (
          <span key={index}>{content}</span>
        );
      })}
    </>
  );
}
