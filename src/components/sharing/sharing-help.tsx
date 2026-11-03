"use client";
import { useId, useRef } from "react";
import { Info } from "lucide-react";
import { useT } from "@/components/locale-provider";

/** Top-layer help stays readable outside the sharing dialog's scrolling body. */
export default function SharingHelp({ label, children, id: providedId }: { label: string; children: string; id?: string }) {
  const t = useT(), generatedId = useId(), id = providedId ?? generatedId;
  const tip = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  function show() {
    const popover = tip.current, button = trigger.current;
    if (!popover || !button) return;
    const rect = button.getBoundingClientRect(), width = Math.min(272, window.innerWidth - 24);
    popover.style.width = `${width}px`;
    popover.style.left = `${Math.max(12, Math.min(rect.left - width / 2, window.innerWidth - width - 12))}px`;
    popover.showPopover();
    const height = popover.getBoundingClientRect().height;
    const top = rect.top >= height + 20 ? rect.top - height - 8 : rect.bottom + 8;
    popover.style.top = `${Math.max(12, Math.min(top, window.innerHeight - height - 12))}px`;
  }
  const hide = () => tip.current?.hidePopover();
  return <span className="sharing-help" onMouseEnter={show} onMouseLeave={hide}>
    <button ref={trigger} type="button" className="sharing-help-trigger" aria-label={t("About {setting}", { setting: label })} aria-describedby={id}
      onFocus={show} onBlur={hide} onClick={show}>
      <Info size={14} aria-hidden="true"/>
    </button>
    <div ref={tip} id={id} popover="auto" className="sharing-help-popover" role="tooltip">{children}</div>
  </span>;
}
