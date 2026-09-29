"use client";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Lock } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { drawerHost } from "@/components/version-history";
import { claimShareEducation, dismissShareEducationForever, educationStorage, readShareEducation, shareEducationCompleted, isShareEducationStorageKey, SHARE_EDUCATION_CHANGED_EVENT } from "@/lib/share-education";

export default function PrivateShareEducation({ slug, anchor, onCreate, onOpenChange }: {
  slug: string;
  anchor: RefObject<HTMLButtonElement | null>;
  onCreate: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const [lesson, setLesson] = useState(false);
  const dismissed = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    const storage = educationStorage("localStorage");
    // Defer the claim until Strict Mode's disposable effect has cleaned up.
    void Promise.resolve().then(async () => {
      const isActive = () => alive && !dismissed.current;
      if (!isActive()) return;
      const claimed = await claimShareEducation(storage, educationStorage("sessionStorage"), slug, Date.now(), isActive);
      if (claimed && isActive() && !shareEducationCompleted(readShareEducation(storage))) setLesson(true);
    });
    const sync = () => {
      if (shareEducationCompleted(readShareEducation(storage))) {
        dismissed.current = true;
        setLesson(false);
      }
    };
    const onStorage = (event: StorageEvent) => { if (isShareEducationStorageKey(event.key)) sync(); };
    window.addEventListener(SHARE_EDUCATION_CHANGED_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => { alive = false; window.removeEventListener(SHARE_EDUCATION_CHANGED_EVENT, sync); window.removeEventListener("storage", onStorage); };
  }, [slug]);
  useEffect(() => {
    onOpenChange(lesson);
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
  const dismiss = () => { dismissed.current = true; setLesson(false); };
  return createPortal(<div ref={panel} className="private-share-education" role="note">
    <div className="private-share-education-head"><span className="private-share-education-icon"><Lock size={14} aria-hidden="true" /></span><b>{t("Private site — use a share link")}</b></div>
    <p>{t("This page address /s/{slug} is only accessible to people who already have permission. To share with others, copy or create a share link in Sharing settings.", { slug })}</p>
    <div className="private-share-education-actions">
      <button type="button" className="btn primary sm" onClick={() => { dismiss(); onCreate(); }}>{t("Go to sharing")}</button>
      <button type="button" className="btn sm" onClick={() => { dismiss(); anchor.current?.focus(); }}>{t("Got it")}</button>
      <button type="button" className="btn sm ghost private-share-education-opt-out" onClick={() => {
        dismissShareEducationForever(educationStorage("localStorage"));
        window.dispatchEvent(new Event(SHARE_EDUCATION_CHANGED_EVENT));
        dismiss(); anchor.current?.focus();
      }}>{t("Don't remind me again")}</button>
    </div>
  </div>, host);
}
