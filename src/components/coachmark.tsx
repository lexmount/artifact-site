"use client";
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "@/lib/use-auth";
import { useT } from "@/components/locale-provider";
import { canTeach, hintKey, learnHint, readHint, writeHint } from "@/lib/coachmarks";
let active: string | null = null;
const sessionSeen = new Set<string>();
export default function Coachmark({ name, selector, enabled = true, manual = false, seconds = 8, text, action, actionLabel, onOpenChange }: { name: string; selector: string; enabled?: boolean; manual?: boolean; seconds?: number; text: string; action?: () => void; actionLabel?: string; onOpenChange?: (open: boolean) => void }) {
  const { user, loading } = useAuth(), t = useT();
  const id = useId();
  const remaining = useRef(seconds * 1000);
  const key = hintKey(user?.id ?? "browser", name), box = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; arrow: number } | null>(null);
  const [mode, setMode] = useState<"auto" | "manual" | "hover" | null>(null);
  const [paused, setPaused] = useState(false), [closing, setClosing] = useState(false);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const close = useCallback(() => {
    if (dismissTimer.current) return;
    setClosing(true);
    dismissTimer.current = setTimeout(() => { setMode(null); setClosing(false); dismissTimer.current = null; if (active === key) active = null; }, 150);
  }, [key]);
  useEffect(() => () => { if (dismissTimer.current) clearTimeout(dismissTimer.current); }, []);
  useEffect(() => {
    if (!enabled || loading) return;
    const anchor = document.querySelector<HTMLElement>(selector); if (!anchor) return;
    const place = () => { const r = anchor.getBoundingClientRect(); const left = Math.max(12, Math.min(r.left, window.innerWidth - 332)); setPosition({ top: Math.min(r.bottom + 8, window.innerHeight - 160), left, arrow: Math.max(12, Math.min(296, r.left + r.width / 2 - left)) }); };
    const show = (next: "auto" | "manual" | "hover") => {
      if (active && active !== key) return;
      const r = anchor.getBoundingClientRect(); if (!r.width || r.bottom < 0) return;
      if (dismissTimer.current) { clearTimeout(dismissTimer.current); dismissTimer.current = null; } setClosing(false);
      active = key; place(); setMode(current => { if (next === "hover" && current) return current; if (next === "manual" && current === "manual") { active = null; return null; } return next; });
    };
    let seen = sessionSeen.has(key); try { seen ||= sessionStorage.getItem(key) === "1"; } catch { /* optional */ }
    if (canTeach(readHint(key), seen) && !active) {
      show("auto"); sessionSeen.add(key); try { sessionStorage.setItem(key, "1"); } catch { /* optional */ }
      writeHint(key, { ...readHint(key), seen: readHint(key).seen + 1 });
    }
    const enter = () => { show("hover"); setPaused(true); };
    const leave = (event: MouseEvent | FocusEvent) => { if (event.relatedTarget instanceof Node && box.current?.contains(event.relatedTarget)) return; setPaused(false); setMode(current => { if (current === "hover") { active = null; return null; } return current; }); };
    const click = () => { if (manual) show("manual"); else close(); };
    if (manual) { anchor.addEventListener("mouseenter", enter); anchor.addEventListener("mouseleave", leave); anchor.addEventListener("focus", enter); anchor.addEventListener("blur", leave); }
    anchor.addEventListener("click", click);
    const outside = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const learned = (e: Event) => { if ((e as CustomEvent).detail === key) close(); };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape); window.addEventListener("blur", close); window.addEventListener("artifact:hint-learned", learned);
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { if (active === key) active = null; setMode(null); anchor.removeEventListener("click", click); anchor.removeEventListener("mouseenter", enter); anchor.removeEventListener("mouseleave", leave); anchor.removeEventListener("focus", enter); anchor.removeEventListener("blur", leave); document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); window.removeEventListener("blur", close); window.removeEventListener("artifact:hint-learned", learned); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
    // Only a change of target or eligibility starts a new teaching opportunity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, loading, key, selector, manual]);
  useEffect(() => { if (mode === "auto") remaining.current = seconds * 1000; }, [mode, seconds]);
  useEffect(() => {
    if (mode !== "auto" || paused) return;
    const start = Date.now(), timer = setTimeout(close, remaining.current);
    return () => { clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (Date.now() - start)); };
  }, [mode, paused, close]);
  useEffect(() => {
    if (!mode) return;
    const anchor = document.querySelector(selector); if (!anchor) return;
    const previous = anchor.getAttribute("aria-describedby"); anchor.setAttribute("aria-describedby", id);
    return () => { if (previous) anchor.setAttribute("aria-describedby", previous); else anchor.removeAttribute("aria-describedby"); };
  }, [mode, selector, id]);
  useEffect(() => { onOpenChange?.(enabled && Boolean(mode)); return () => onOpenChange?.(false); }, [enabled, mode, onOpenChange]);
  if (!enabled || !mode || !position) return null;
  return createPortal(<div id={id} ref={box} role="note" className="coachmark" data-closing={closing} style={{ top: position.top, left: position.left, "--coach-arrow": `${position.arrow}px` } as CSSProperties} onMouseEnter={() => setPaused(true)} onMouseLeave={() => { setPaused(false); if (mode === "hover") close(); }} onFocus={() => setPaused(true)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) { setPaused(false); if (mode === "hover") close(); } }}>
    <p>{text}</p><div><button className="quiet" onClick={() => { learnHint(user?.id ?? "browser", name); close(); }}>{t("Got it")}</button>{action && <button className="quiet" onClick={() => { action(); learnHint(user?.id ?? "browser", name); close(); }}>{actionLabel}</button>}</div>
  </div>, document.body);
}
