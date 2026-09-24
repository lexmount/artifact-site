"use client";

// The "which version to edit from" selection step before entering the editor.
//
// Only appears when the site really has several versions (see PICKER_MIN_VERSIONS in lib/edit-base)
// — with a single version this screen carries no information and is pure obstruction. When it does
// appear it is not a form that demands choosing item by item: the primary action "Edit the current
// version" is an auto-focused solid button that goes with one click (or just Enter), and each
// historical version carries its own "Edit from this version". Most people want to edit the current
// version, and that road must be the shortest.
//
// Three exits, matching the three choices in the user's own words:
//   1. Edit from the current version    → ?version=<current version>
//   2. Edit from a historical version   → ?version=<that version> (saving is still forward-only; the copy says so)
//   3. Make a copy and edit it          → POST /fork, then jump to the copy's edit page
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import ViewerBrand from "@/components/viewer-brand";
import { useRouter } from "next/navigation";
import { Copy, Eye, History, Loader2, MousePointerClick, Pencil } from "lucide-react";
import type { VersionInfo } from "@/lib/types";
import { relTime } from "@/lib/rel-time";
import { baseVersionUsable, fmtBytes, versionLabel, type EditEntryPlan } from "@/lib/edit-base";
import { rememberEditToken } from "@/lib/edit-token";
import { useLocale, useT } from "@/components/locale-provider";
import { countText } from "@/lib/i18n";

const SOURCE_LABEL: Record<VersionInfo["source"], string> = {
  upload: "Uploaded", edit: "Edited", fork: "Forked", rollback: "Rolled back", build: "Built",
};

export default function VersionPicker({ slug, title, kind, versions, currentVersionId, currentEntry, notice }: {
  slug: string;
  title: string;
  kind: "single" | "folder";
  /** The result of listVersions: newest → oldest, already filtered by siteId. */
  versions: VersionInfo[];
  currentVersionId: string;
  currentEntry: string;
  /** Why the previous ?version= did not count (see lib/edit-base). */
  notice: Extract<EditEntryPlan, { step: "picker" }>["notice"];
}) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [forking, setForking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The default option must be passable with a single Enter — this step is a hint, not a gate that has to be cleared by hand.
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { primaryRef.current?.focus(); }, []);

  const current = versions.find((v) => v.id === currentVersionId);
  const older = versions.filter((v) => v.id !== currentVersionId);

  function edit(versionId: string) {
    router.push(`/s/${slug}/edit?version=${encodeURIComponent(versionId)}`);
  }

  // Make a copy — fork copies the CURRENT version, and the endpoint accepts no version parameter (see
  // forkSite in lib/sites). So this must never promise "copy the selected old version into a copy" —
  // that is something it cannot do.
  async function forkAndEdit() {
    if (forking) return;
    setForking(true);
    setError(null);
    try {
      const res = await fetch(`/api/sites/${slug}/fork`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || t("Failed to save a copy"));
      if (data.editToken) rememberEditToken(data.slug, data.editToken);
      router.push(`/s/${data.slug}/edit`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Failed to save a copy"));
      setForking(false);
    }
  }

  return (
    <div className="vp">
      <header className="editor-bar">
        <div className="editor-bar-left">
          <Link className="brand" href={`/s/${slug}`} aria-label={t("Back to the viewer")}>
            <ViewerBrand />
          </Link>
          <div className="header-title" title={title}>{title}</div>
          <span className="editor-meta">{countText(t, versions.length, "{n} version", "{n} versions")}</span>
        </div>
      </header>

      <div className="vp-body">
        <div className="vp-head">
          <h1 className="vp-title"><History size={18} aria-hidden="true" /> {t("Which version do you want to edit from?")}</h1>
          <p className="vp-lede">
            {t("This site has {n} versions. By default you edit the current one; you can also start from an earlier version, or make an independent copy and edit that.", { n: versions.length })}
          </p>
        </div>

        {notice && <p className="vp-notice" role="alert">{notice}</p>}
        {error && <p className="drawer-error" role="alert">{error}</p>}

        {/* 1. Current version — the primary action, auto-focused, in with one click / Enter. */}
        <section className="vp-primary">
          <div className="vp-primary-text">
            <b>{t("Edit the current version")}</b>
            <span>
              {current ? `${versionLabel(versions, current.id)} · ${relTime(current.createdAt, t, locale)} · ${t(SOURCE_LABEL[current.source] ?? current.source)}` : t("The version currently being served")}
            </span>
          </div>
          <button type="button" className="btn solid" ref={primaryRef} onClick={() => edit(currentVersionId)}>
            <MousePointerClick size={15} /> {t("Start editing")}
          </button>
        </section>

        {/* 2. Historical versions — each row carries its own exit, no select-then-continue. */}
        {older.length > 0 && (
          <section className="vp-section">
            <h2 className="vp-section-title">{t("Or start from an earlier version")}</h2>
            <p className="vp-hint">
              {t("Saving")} <b>{t("creates a new version on top of the current one")}</b>{t("; the earlier version itself is never rewritten — think of it as fetching the old content, changing a few words and saving it as the latest.")}
              {kind === "folder" && <> {t("This is a folder site: only the file you actually edit comes from the chosen version; every other file still comes from the current version.")}</>}
            </p>
            <div className="vp-list">
              {older.map((v) => {
                const usable = baseVersionUsable(v, currentEntry);
                return (
                  <div key={v.id} className="ver-row">
                    <div className="ver-row-head">
                      <span className="ver-num">{versionLabel(versions, v.id)}</span>
                      <span className="kind-chip">{t(SOURCE_LABEL[v.source] ?? v.source)}</span>
                    </div>
                    <div className="ver-row-meta">
                      <span>{relTime(v.createdAt, t, locale)}</span>
                      <span className="dot" aria-hidden="true" />
                      <span>{countText(t, v.fileCount, "{n} file", "{n} files")}</span>
                      <span className="dot" aria-hidden="true" />
                      <span>{fmtBytes(v.byteSize)}</span>
                    </div>
                    {!usable && (
                      <p className="vp-row-warn">
                        {t("Its entry file is {entry}, but the current version's is {currentEntry} — editing from it would write changes into a file that is never served, so it cannot be chosen.", { entry: v.entry, currentEntry })}
                      </p>
                    )}
                    <div className="ver-row-actions">
                      <a className="btn sm ghost" href={`/api/preview/${slug}/?v=${v.id}`} target="_blank" rel="noreferrer">
                        <Eye size={13} /> {t("Preview this version")}
                      </a>
                      <button type="button" className="btn sm" disabled={!usable} onClick={() => edit(v.id)}>
                        <Pencil size={13} /> {t("Edit from this version")}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* 3. Make a copy — the copy only dares promise what fork can actually do: copy the current version. */}
        <section className="vp-section">
          <h2 className="vp-section-title">{t("Or leave this site untouched")}</h2>
          <p className="vp-hint">
            {t("Duplicate it into an independent new site and edit that; the original does not change at all. The copy takes the")} <b>{t("current version")}</b> {t("(history is not carried over; the copy starts at v1) — to start from an earlier version, use \"Edit from this version\" above.")}
          </p>
          <div className="ver-row-actions">
            <button type="button" className="btn sm" onClick={forkAndEdit} disabled={forking}>
              {forking ? <Loader2 size={13} className="spin" /> : <Copy size={13} />} {t("Make a copy and edit it")}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
