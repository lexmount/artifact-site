import { expect, it, vi } from "vitest";
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(url);
  }),
);
vi.mock("next/navigation", () => ({ redirect }));
import CommentReviewPage from "@/app/s/[slug]/comments/page";
it("redirects existing review bookmarks to the unified sidebar with the selected thread", async () => {
  await expect(
    CommentReviewPage({
      params: Promise.resolve({ slug: "fixture" }),
      searchParams: Promise.resolve({ thread: "thread_1" }),
    }),
  ).rejects.toThrow("/s/fixture?comments=all&thread=thread_1");
});
it("does not forward malformed thread IDs", async () => {
  await expect(
    CommentReviewPage({
      params: Promise.resolve({ slug: "fixture" }),
      searchParams: Promise.resolve({ thread: "<script>" }),
    }),
  ).rejects.toThrow(/^\/s\/fixture\?comments=all$/);
});
