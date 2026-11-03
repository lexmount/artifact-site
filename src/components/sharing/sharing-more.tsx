"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Folder, Link2, MoreHorizontal, ShieldCheck, ShieldOff } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { canStopSharing, type DocumentSharingState } from "./main-sharing-model";

/** Kept inside the modal: body portals would be inert behind its top layer. */
export default function SharingMore({ data, disabled, onLinks, onMembers, onFollow, onStop }: {
  data: DocumentSharingState | null;
  disabled: boolean;
  onLinks: () => void;
  onMembers?: () => void;
  onFollow: () => void;
  onStop: () => void;
}) {
  const t = useT(), id = useId(), root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);
  function focusItem(last = false) {
    requestAnimationFrame(() => {
      const items = root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
      items?.[last ? items.length - 1 : 0]?.focus();
    });
  }
  return <div className="sharing-more" ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
  }} onKeyDown={event => {
    if (!open) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const items = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    }
  }}>
    <button ref={trigger} type="button" className="btn sm ghost" aria-label={t("More sharing options")} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled}
      onClick={() => { setOpen(!open); if (!open) focusItem(); }} onKeyDown={event => {
        if (!open && ["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setOpen(true); focusItem(event.key === "ArrowUp"); }
      }}><MoreHorizontal size={18}/></button>
    {open && <div id={id} role="menu" aria-label={t("More sharing options")} className="sharing-more-menu" onClick={event => {
      if ((event.target as HTMLElement).closest('[role="menuitem"]')) { setOpen(false); trigger.current?.focus(); }
    }}>
      {onMembers && <button type="button" role="menuitem" onClick={onMembers}><ShieldCheck size={16}/>{t("Permission settings")}</button>}
      <button type="button" role="menuitem" onClick={onLinks}><Link2 size={16}/>{t("Independent sharing links")}{data && data.links > 0 ? ` (${data.links})` : ""}</button>
      {data?.follow && data.source === "manual" && <button type="button" role="menuitem" onClick={onFollow}><Folder size={16}/>{t(data.follow.source === "folder" || data.follow.source === "all" ? "Restore shared settings" : "Restore default sharing settings")}</button>}
      {data && canStopSharing(data) && <button type="button" role="menuitem" className="sharing-stop" onClick={onStop}><ShieldOff size={16}/>{t("Close all sharing…")}</button>}
    </div>}
  </div>;
}
