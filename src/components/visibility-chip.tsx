"use client";
import { useId, useRef } from "react";
import { Lock, Link2, Globe } from "lucide-react";
import type { Visibility } from "@/lib/types";
import { useT } from "@/components/locale-provider";

const MARKS = {
  private: { icon: Lock, label: "Authorized people only", hint: "Only authorized people can open this address. Change access in Sharing to invite more people." },
  unlisted: { icon: Link2, label: "Anyone with the link can access", hint: "Excluded from Explore and search results for unrelated people." },
  public: { icon: Globe, label: "Public", hint: "Shown in Explore and discoverable through search." },
} as const;

export default function VisibilityChip({ visibility }: { visibility?: Visibility }) {
  const t = useT(), id = useId();
  const tip = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!visibility) return null;
  const mark = MARKS[visibility], Icon = mark.icon;
  const show = () => {
    const popover = tip.current, button = trigger.current;
    if (!popover || !button) return;
    const rect = button.getBoundingClientRect();
    const width = Math.min(280, window.innerWidth - 24);
    popover.style.width = `${width}px`;
    popover.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    popover.showPopover();
    const height = popover.getBoundingClientRect().height;
    popover.style.top = `${Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - height - 12))}px`;
  };
  const hide = () => tip.current?.hidePopover();
  return <>
    <button ref={trigger} type="button" className={`vis-chip vis-${visibility}`} aria-describedby={id}
      onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} onClick={show}>
      <Icon size={12} aria-hidden="true" />
      <span className={visibility === "unlisted" ? "vis-label-full" : undefined}>{t(mark.label)}</span>
      {visibility === "unlisted" && <span className="vis-label-short">{t("Via link")}</span>}
    </button>
    <div ref={tip} id={id} popover="auto" className="visibility-explanation" role="tooltip">{t(mark.hint)}</div>
  </>;
}
