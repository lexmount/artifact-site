import emojiRegex from "emoji-regex";
import data from "emoji-picker-react/src/data/emojis.json";

// Canonical picker forms also cover clients using text-default/VS16-less input.
const forms = new Map<string,string>();
for (const group of Object.values(data.emojis)) for (const item of group) {
  for (const code of [item.u, ...("v" in item ? item.v ?? [] : [])]) {
    const native = String.fromCodePoint(...code.split("-").map(part=>parseInt(part,16)));
    forms.set(native.replaceAll("\ufe0f", ""), native);
  }
}
export function canonicalCommentEmoji(value: string): string | null {
  if (!value || value.length > 128) return null;
  // A modifier, regional indicator or hair component by itself is not a reaction.
  if (Array.from(value).length === 1 && /\p{Emoji_Component}/u.test(value)) return null;
  const match = emojiRegex().exec(value);
  if (match?.index !== 0 || match[0] !== value) return null;
  return forms.get(value.replaceAll("\ufe0f", "")) ?? value;
}
export function isCommentEmoji(value: string): boolean { return canonicalCommentEmoji(value) !== null; }
