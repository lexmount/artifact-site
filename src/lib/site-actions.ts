"use client";

// The four things a person does to one of their sites from a list — copy its link, save a copy,
// rename it, delete it — plus the toast that reports each. Shared by the account list (my-sites)
// (and formerly the card grid), so the edit-token header, the strings and the "tell the host to
// refetch" rule live in exactly one place.
import { siteFetch as fetch } from "@/lib/share-context";
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { rememberEditToken } from "@/lib/edit-token";
import { useT } from "@/components/locale-provider";

export function useSiteActions(tokens: Readonly<Record<string, string | undefined>>, onMutated?: () => void) {
  const t = useT();
  const router = useRouter();
  const [deleteRequest, setDeleteRequest] = useState<{ slug: string; title: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [forking, setForking] = useState<string | null>(null);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2400);
  }, []);

  // Anonymous creators prove ownership with the browser's token; account owners are known to the server.
  const tokenHeader = (slug: string): Record<string, string> => (tokens[slug] ? { "x-edit-token": tokens[slug] as string } : {});

  async function copyLink(slug: string) {
    const url = `${window.location.origin}/s/${slug}`;
    try {
      await navigator.clipboard.writeText(url);
      flash(t("Link copied"));
    } catch {
      flash(url);
    }
  }

  // Save as new site — duplicate into an independent site, then open it.
  async function fork(slug: string) {
    if (forking) return;
    setForking(slug);
    try {
      const res = await fetch(`/api/sites/${slug}/fork`, { method: "POST",headers:tokenHeader(slug) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || t("Failed to save a copy"));
      // The fork is ours: keep its fresh edit token so we can edit the new copy.
      if (data.editToken) rememberEditToken(data.slug, data.editToken);
      flash(t("Saved as a new site"));
      router.push(`/s/${data.slug}`);
    } catch (e) {
      flash(e instanceof Error ? e.message : t("Failed to save a copy"));
      setForking(null);
    }
  }

  // Rename — commit an inline title edit via PATCH. Both success paths notify the host: with
  // router.refresh alone, a list held in useState would keep the old title.
  async function rename(slug: string, next: string, prev: string) {
    if (!next || next === prev) return;
    try {
      const res = await fetch(`/api/sites/${slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...tokenHeader(slug) },
        body: JSON.stringify({ title: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || t("Failed to rename"));
      flash(t("Renamed"));
      router.refresh();
      onMutated?.();
    } catch (e) {
      flash(e instanceof Error ? e.message : t("Failed to rename"));
    }
  }

  function remove(slug: string, title: string) { setDeleteRequest({ slug, title }); }

  async function confirmDelete() {
    if (!deleteRequest || pending) throw new Error(t("Failed to delete"));
    const { slug } = deleteRequest;
    setPending(slug);
    try {
      const res = await fetch(`/api/sites/${slug}`, { method: "DELETE", headers: tokenHeader(slug) });
      if (!res.ok && res.status !== 404) throw new Error();
      flash(t("Deleted"));
      router.refresh();
      onMutated?.();
    } catch {
      throw new Error(t("Failed to delete"));
    } finally {
      setPending(null);
    }
  }

  return { toast, flash, pending, forking, copyLink, fork, rename, remove, deleteRequest, confirmDelete, cancelDelete: () => setDeleteRequest(null) };
}
