import { describe, expect, it } from "vitest";
import { isCommentEmoji, canonicalCommentEmoji } from "@/lib/comments/emoji";
import data from "emoji-picker-react/src/data/emojis.json";

describe("Unicode comment reactions", () => {
  it.each(["👍", "🦦", "👍🏽", "👩🏽‍💻", "👨‍👩‍👧‍👦", "🇨🇳", "1️⃣", "🏳️‍🌈", "❤️", "🫩"])("accepts a complete sequence: %s", emoji => {
    expect(isCommentEmoji(emoji)).toBe(true);
    expect(isCommentEmoji(emoji)).toBe(true);
  });
  it.each(["", "hello", "👍👍", "a👍", "👍a", " 👍", "👍\n", "<img>", "🇨", "1", "🏻", "🦰", "👍".repeat(100)])("rejects non-single emoji: %s", emoji => {
    expect(isCommentEmoji(emoji)).toBe(false);
  });
  it("canonicalizes text and presentation-selector variants",()=>{
    expect(canonicalCommentEmoji("❤")).toBe(canonicalCommentEmoji("❤️"));
    expect(canonicalCommentEmoji("#⃣")).toBe(canonicalCommentEmoji("#️⃣"));
    expect(canonicalCommentEmoji("©")).toBe(canonicalCommentEmoji("©️"));
  });
  it("accepts every picker entry and skin-tone variant", () => {
    for (const group of Object.values(data.emojis)) for (const emoji of group) {
      for (const unified of [emoji.u, ...("v" in emoji ? emoji.v ?? [] : [])]) {
        const native = String.fromCodePoint(...unified.split("-").map(code => parseInt(code,16)));
        expect(isCommentEmoji(native), unified).toBe(true);
      }
    }
  });
});
