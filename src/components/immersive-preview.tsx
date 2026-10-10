"use client";

import { appPath } from "@/lib/app-path";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2 } from "lucide-react";
import { useT } from "@/components/locale-provider";

/** The host presentation shell preserves the sandbox, access gate and selected version. */
export default function ImmersivePreview({ slug, versionId }: { slug: string; versionId: string }) {
  const t = useT();
  const id = useId();
  const [tip, setTip] = useState<{ left: number; top: number } | null>(null);
  const hint = t("Open a pure preview in a new tab, without the toolbar");
  const show = (anchor: HTMLAnchorElement) => {
    const rect = anchor.getBoundingClientRect();
    setTip({ left: Math.max(12, Math.min(rect.left, window.innerWidth - 252)), top: rect.bottom + 8 });
  };
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    document.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
      document.removeEventListener("keydown", escape);
    };
  }, [tip]);
  return <>
    <a className="btn icon-only header-immersive" href={appPath(`/s/${encodeURIComponent(slug)}?version=${encodeURIComponent(versionId)}&presentation=1`)}
      target="_blank" rel="noopener noreferrer" aria-label={t("Immersive preview (opens in a new tab)")}
      aria-describedby={tip ? id : undefined}
      onPointerEnter={event => { if (event.pointerType === "mouse") show(event.currentTarget); }}
      onPointerLeave={() => setTip(null)}
      onFocus={event => { if (event.currentTarget.matches(":focus-visible")) show(event.currentTarget); }}
      onBlur={() => setTip(null)} onClick={() => setTip(null)}>
      <Maximize2 size={14} aria-hidden="true" />
    </a>
    {tip && createPortal(<div id={id} role="tooltip" className="header-pin-tooltip" style={tip}>{hint}</div>, document.body)}
  </>;
}
