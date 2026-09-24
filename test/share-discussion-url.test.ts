import { expect, it } from "vitest";
import { shareDiscussionUrl } from "@/components/share-model";
it("adds the discussion query before a fragment and preserves other parameters", () => {
  expect(shareDiscussionUrl("https://example.test/v/a#section")).toBe("https://example.test/v/a?comments=1#section");
  expect(shareDiscussionUrl("https://example.test/v/a?welcome=0&comments=all#section")).toBe("https://example.test/v/a?welcome=0&comments=1#section");
});
