"use client";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Lock } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { drawerHost } from "@/components/version-history";
import { acknowledgeShareEducation, readAcknowledgements, shouldShowShareEducation, isShareEducationStorageKey, SHARE_LINK_CREATED_EVENT } from "@/lib/share-education";

function storage(): Storage | null { try { return window.localStorage; } catch { return null; } }

export default function PrivateShareEducation({ slug, anchor, onCreate, onOpenChange }: {
  slug: string;
  anchor: RefObject<HTMLButtonElement | null>;
  onCreate: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const [lesson, setLesson] = useState<{scope: string; step: number} | null>(null);
  const dismissed = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    let generation = 0;
    const sync = async () => {
      const current = ++generation;
      try {
        const response = await fetch("/api/me/share-education", { cache: "no-store" });
        if (!response.ok) return;
        const history = await response.json() as {scope: string; linksCreated: number};
        if (!alive || dismissed.current || current !== generation) return;
        const count = readAcknowledgements(storage(), history.scope, slug);
        setLesson(shouldShowShareEducation(count, history.linksCreated) ? {scope: history.scope, step: count + 1} : null);
      } catch { /* Optional guidance must not block sharing. */ }
    };
    void sync();
    const onStorage = (event: StorageEvent) => { if (isShareEducationStorageKey(event.key)) void sync(); };
    window.addEventListener(SHARE_LINK_CREATED_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => { alive = false; window.removeEventListener(SHARE_LINK_CREATED_EVENT, sync); window.removeEventListener("storage", onStorage); };
  }, [slug]);
  useEffect(() => {
    onOpenChange(lesson !== null);
    return () => onOpenChange(false);
  }, [lesson, onOpenChange]);
  useLayoutEffect(() => {
    if (!lesson) return;
    const position = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect || !panel.current) return;
      const box = panel.current;
      box.style.left = `${Math.max(12, Math.min(rect.right - box.offsetWidth, innerWidth - box.offsetWidth - 12))}px`;
      box.style.top = `${Math.max(12, Math.min(rect.bottom + 12, innerHeight - box.offsetHeight - 12))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    if (anchor.current) observer.observe(anchor.current);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.addEventListener("transitionend", position, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); window.removeEventListener("transitionend", position, true); };
  }, [anchor, lesson]);
  const host = drawerHost(typeof document === "undefined" ? null : document);
  if (!lesson || !host) return null;
  const dismiss = () => { dismissed.current = true; setLesson(null); };
  return createPortal(<div ref={panel} className="private-share-education" role="note">
    <div className="private-share-education-head"><span className="private-share-education-icon"><Lock size={14} aria-hidden="true" /></span><b>{t("This is a private site")}</b><span>{t("Reminder")} {lesson.step}/3</span></div>
    <p>{t("Use a share link to invite more people. Existing members and people with valid share links may already have access.")}</p>
    <div className="private-share-education-actions">
      <button type="button" className="btn primary sm" onClick={() => { dismiss(); onCreate(); }}>{t("New share link")}</button>
      <button type="button" className="btn sm" onClick={() => { acknowledgeShareEducation(storage(), lesson.scope, slug); dismiss(); anchor.current?.focus(); }}>{t("Got it")}</button>
    </div>
  </div>, host);
}
