"use client";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useT } from "@/components/locale-provider";
import CommentWorkspace from "./anchored-workspace";
import type { CommentWorkspaceProps } from "./comment-workspace";

/** Reader chrome preserves the server-rendered artifact and header; comments stay in the host. */
export default function SharedCommentShell({ children, header, comments }: {
  children: ReactNode; header: ReactNode; comments: CommentWorkspaceProps;
}) {
  const [barOpen, setBarOpen] = useState(true);
  const t = useT();
  const viewer = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  useLayoutEffect(() => { frameRef.current = viewer.current?.querySelector("iframe") ?? null; }, []);
  useEffect(() => {
    const node = viewer.current, bar = node?.querySelector("header");
    if (!node || !bar) return;
    const sync = () => node.style.setProperty("--fs-bar-h", `${Math.round(bar.getBoundingClientRect().height)}px`);
    sync(); const observer = new ResizeObserver(sync); observer.observe(bar);
    return () => observer.disconnect();
  }, []);
  return <div ref={viewer} className="fs-viewer" data-device="desktop" data-bar={barOpen ? "open" : "closed"}>
    {children}
    <div className={`fs-chrome${barOpen ? " is-open" : ""}`} onFocusCapture={() => setBarOpen(true)}>
      {header}
      <button type="button" className="fs-handle" aria-expanded={barOpen} aria-label={barOpen ? t("Hide action bar") : t("Show action bar")} onClick={() => setBarOpen(!barOpen)}>{barOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>
    </div>
    <CommentWorkspace {...comments} frameRef={frameRef} key={`${comments.scope.versionId}:${comments.scope.entry.kind === "share" ? comments.scope.entry.shareId : "main"}`} />
  </div>;
}
