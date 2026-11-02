"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { appPath } from "@/lib/app-path";
import { useT } from "@/components/locale-provider";

/** The opaque frame reports only its presentation state, never a URL to navigate to. */
export default function PackageNavigation({ directoryUrl }: { directoryUrl: string }) {
  const t = useT();
  const nav = useRef<HTMLElement>(null);
  const [insideFile, setInsideFile] = useState(false);
  useEffect(() => {
    const wrap = nav.current?.closest(".fs-stage-wrap");
    const frame = () => wrap?.querySelector("iframe");
    const probe = () => frame()?.contentWindow?.postMessage({ type: "artifact:package-location-request" }, "*");
    const receive = (event: MessageEvent) => {
      if (event.source !== frame()?.contentWindow || event.data?.type !== "artifact:package-location") return;
      if (typeof event.data.directory === "boolean") setInsideFile(!event.data.directory);
    };
    window.addEventListener("message", receive);
    wrap?.addEventListener("load", probe, true);
    probe();
    return () => { window.removeEventListener("message", receive); wrap?.removeEventListener("load", probe, true); };
  }, []);
  return <nav ref={nav} className="package-navigation" aria-label={t("File directory")} hidden={!insideFile}>
    <button className="btn sm ghost" onClick={() => {
      const frame = nav.current?.closest(".fs-stage-wrap")?.querySelector("iframe");
      if (frame) { setInsideFile(false); frame.src = appPath(directoryUrl); }
    }}><ArrowLeft size={14} aria-hidden="true" />{t("Back to file directory")}</button>
  </nav>;
}
