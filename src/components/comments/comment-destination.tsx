"use client";
import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Info, Check, Link, MessageCircle } from "lucide-react";
import { useT, useLocale } from "@/components/locale-provider";
export interface DestinationOption { id: string; label: string; createdAt?: number; disabled?: boolean }
export function CommentDestination({ value, options, disabled, onChange }: { value: string; options: DestinationOption[]; disabled: boolean; onChange: (value: string) => void }) {
  const t = useT(), locale = useLocale(), id = useId();
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const current = options.find(option => option.id === value);
  const info = t("Each link has its own discussion. From the main discussion, you can send comments to a share link's discussion.");
  const close = (focus = false) => { menu.current?.hidePopover(); if (focus) trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      menu.current?.hidePopover();
    };
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    window.visualViewport?.addEventListener("resize", dismiss);
    return () => { window.removeEventListener("resize", dismiss); window.removeEventListener("scroll", dismiss, true); window.visualViewport?.removeEventListener("resize", dismiss); };
  }, [open]);
  const show = () => {
    const element = menu.current, button = trigger.current;
    if (!element || !button || disabled) return;
    if (element.matches(":popover-open")) { close(); return; }
    const rect = button.getBoundingClientRect(), viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
    const above = rect.top - top - 16, below = top + height - rect.bottom - 16;
    const upwards = below < 240 && above > below;
    element.style.width = `${Math.min(320, width - 24)}px`;
    element.style.maxHeight = `${Math.max(40, Math.min(280, upwards ? above : below))}px`;
    element.showPopover();
    const box = element.getBoundingClientRect();
    element.style.left = `${Math.max(left + 12, Math.min(rect.right - box.width, left + width - box.width - 12))}px`;
    element.style.top = `${Math.max(top + 12, upwards ? rect.top - box.height - 6 : rect.bottom + 6)}px`;
    const selected = element.querySelector<HTMLButtonElement>('button[aria-pressed="true"]:not(:disabled)')
      ?? element.querySelector<HTMLButtonElement>('button:not(:disabled)');
    selected?.focus({preventScroll:true});
    if (selected) {
      const row = selected.getBoundingClientRect(), bounds = element.getBoundingClientRect();
      if (row.bottom > bounds.bottom) element.scrollTop += row.bottom - bounds.bottom + 6;
      else if (row.top < bounds.top) element.scrollTop -= bounds.top - row.top + 6;
    }
  };
  return <div className="comment-destination">
    <span>{t("Comment in")}</span>
    <span className="comment-destination-help"><button type="button" aria-label={info}><Info size={14} /></button><span role="tooltip">{info}</span></span>
    <div className="comment-destination-picker">
      <button ref={trigger} type="button" data-trigger aria-label={t("Comment in")} aria-expanded={open} aria-controls={id} disabled={disabled} data-value={value} popoverTarget={id} onClick={event=>{event.preventDefault();show();}}>
        {value === "main" ? <MessageCircle size={14}/> : <Link size={14}/>}
        <span title={current?.label}>{current?.label}</span><ChevronDown size={14}/>
      </button>
      <div ref={menu} id={id} popover="auto" className="comment-destination-options" aria-label={t("Comment in")} onToggle={event=>setOpen(event.newState === "open")} onKeyDown={event=>{
        if(event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
        if(event.key === "Tab") { close(true); return; }
        if(!["ArrowDown","ArrowUp","Home","End"].includes(event.key)) return;
        event.preventDefault();
        const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length-1 : (index+(event.key === "ArrowDown" ? 1 : -1)+buttons.length)%buttons.length]?.focus();
      }}>
        {options.map(option=><button key={option.id} type="button" data-value={option.id} aria-pressed={value === option.id} disabled={disabled || option.disabled} onClick={()=>{onChange(option.id);close(true);}}>
          {option.id === "main" ? <MessageCircle size={16}/> : <Link size={16}/>}
          <span className="comment-destination-label"><span title={option.label}>{option.label}</span>{(option.id !== "main" || option.createdAt) && <small>{option.id !== "main" ? option.id.slice(-6) : ""}{option.id !== "main" && option.createdAt ? " · " : ""}{option.createdAt ? new Intl.DateTimeFormat(locale,{year:"numeric",month:"2-digit",day:"2-digit"}).format(option.createdAt) : ""}</small>}</span>
          {value === option.id && <Check size={15}/>}
        </button>)}
      </div>
    </div>
  </div>;
}
