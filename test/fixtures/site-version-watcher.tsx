import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import SiteVersionWatcher, { ARTIFACT_REFRESH_EVENT } from "../../src/components/site-version-watcher";
import { LocaleProvider } from "../../src/components/locale-provider";

class VersionFeed extends EventTarget {
  static CLOSED = 2;
  static current: VersionFeed;
  readyState = 1;
  onerror: (() => void) | null = null;
  constructor() {
    super();
    VersionFeed.current = this;
    setTimeout(() => this.dispatchEvent(new Event("hello")), 0);
  }
  close() { this.readyState = VersionFeed.CLOSED; }
}
Object.assign(window, { EventSource: VersionFeed });

declare global {
  interface Window {
    watcherFixture: {
      announce: (versionId: string, versionNumber?: number) => void;
      renderVersion: (versionId: string) => void;
      setAutomatic: (automatic: boolean) => void;
      refreshes: number;
      blocked: boolean;
    };
  }
}

function Fixture() {
  const [versionId, setVersionId] = useState("v1");
  const [automatic, setAutomatic] = useState(!location.search.includes("reader"));
  useEffect(() => {
    window.watcherFixture = {
      announce: (id, number) => VersionFeed.current.dispatchEvent(new MessageEvent("version", { data: JSON.stringify({ versionId: id, versionNumber: number }) })),
      renderVersion: setVersionId,
      setAutomatic,
      refreshes: 0,
      blocked: false,
    };
    const refresh = (event: Event) => {
      window.watcherFixture.refreshes++;
      if (window.watcherFixture.blocked) event.preventDefault();
    };
    window.addEventListener(ARTIFACT_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(ARTIFACT_REFRESH_EVENT, refresh);
  }, []);
  return <LocaleProvider locale={location.search.includes("zh") ? "zh-CN" : "en"}>
    <button id="outside">Outside the notice</button>
    <iframe className="fs-frame" title="Artifact preview" sandbox="allow-scripts" src="/api/preview/fixture/" style={{ top: 80, height: 400 }} />
    <SiteVersionWatcher slug="fixture" versionId={versionId} autoRefresh={automatic} />
  </LocaleProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
