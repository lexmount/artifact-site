import { z } from "zod";
export const MENTION_CANDIDATE_LIMIT = 20;
export interface MentionCandidatePage {
  items: { userId: string; label: string }[];
  truncated: boolean;
}
export const mentionSchema = z
  .object({
    userId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    label: z.string().min(1).max(100),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict();
export const mentionsSchema = z.array(mentionSchema).max(20);
export type CommentMention = z.infer<typeof mentionSchema>;
/** Rebase ranges around a single text edit; editing inside a mention removes its identity. */
export function rebaseMentions(
  before: string,
  after: string,
  mentions: CommentMention[],
): CommentMention[] {
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++;
  let oldEnd = before.length,
    newEnd = after.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    before[oldEnd - 1] === after[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  const delta = after.length - before.length;
  return mentions
    .flatMap((m) =>
      m.end <= start
        ? [m]
        : m.start >= oldEnd
          ? [{ ...m, start: m.start + delta, end: m.end + delta }]
          : [],
    )
    .filter((m) => after.slice(m.start, m.end) === "@" + m.label);
}
export function normalizedMentions(
  body: string,
  mentions: CommentMention[],
): CommentMention[] {
  const offset = body.length - body.trimStart().length;
  return mentions
    .filter((m) => body.slice(m.start, m.end) === "@" + m.label)
    .map((m) => ({ ...m, start: m.start - offset, end: m.end - offset }));
}
