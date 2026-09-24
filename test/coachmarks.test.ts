import { expect, it } from "vitest";
import { canTeach, hintKey } from "@/lib/coachmarks";
it("caps passive impressions and separates user learning", () => {
  expect(canTeach({ seen: 0, learned: false }, false)).toBe(true);
  expect(canTeach({ seen: 1, learned: false }, true)).toBe(false);
  expect(canTeach({ seen: 3, learned: false }, false)).toBe(false);
  expect(canTeach({ seen: 1, learned: true }, false)).toBe(false);
  expect(hintKey("a", "private")).not.toBe(hintKey("b", "private"));
});
