import { redirect } from "next/navigation";
/** Keep old review links working; the main viewer owns the single discussion sidebar. */
export default async function CommentReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ thread?: string }>;
}) {
  const { slug } = await params;
  const { thread } = await searchParams;
  const query = new URLSearchParams({ comments: "all" });
  if (thread && /^[A-Za-z0-9_-]{1,128}$/.test(thread)) query.set("thread", thread);
  redirect(`/s/${encodeURIComponent(slug)}?${query}`);
}
