/** CJK prose does not need whitespace before @; email/identifier fragments must not trigger. */
export function mentionTrigger(body: string, caret: number) {
  const before = body.slice(0, caret),
    match = /@([^\s@]{0,50})$/u.exec(before);
  if (!match) return null;
  const previous = Array.from(before.slice(0, match.index)).at(-1);
  const cjk =
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  if (previous && /[\p{L}\p{N}_@.+-]/u.test(previous) && !cjk.test(previous))
    return null;
  return { start: match.index, end: caret, query: match[1] };
}
