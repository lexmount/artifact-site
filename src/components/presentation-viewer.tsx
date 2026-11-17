"use client";
import Link from "next/link";
import { Minimize2 } from "lucide-react";
import { appPath } from "@/lib/app-path";
import { useT } from "@/components/locale-provider";
import { useRef } from "react";
import PreviewNavigation from "@/components/preview-navigation";

/** A host shell keeps untrusted content inside the same sandbox as the normal viewer. */
export default function PresentationViewer({ src, title, returnTo }: { src: string; title: string; returnTo: string }) {
  const t = useT();
  const frameRef = useRef<HTMLIFrameElement>(null);
  return <main className="viewer-presentation">
    <iframe ref={frameRef} title={title} src={appPath(src)} sandbox="allow-forms allow-modals allow-scripts allow-popups allow-downloads" allow="fullscreen"/>
    <PreviewNavigation frameRef={frameRef} />
    <Link className="btn presentation-exit" href={returnTo}><Minimize2 size={14}/>{t("Exit presentation")}</Link>
  </main>;
}
