import { createRoot } from "react-dom/client";
import { useRef } from "react";
import PreviewNavigation from "../../src/components/preview-navigation";
import PresentationViewer from "../../src/components/presentation-viewer";
import CollectionPage from "../../src/components/sharing/collection-page";
import AuthButton from "../../src/components/auth-button";
import SharedCommentShell from "../../src/components/comments/shared-comment-shell";
import { AuthConfigProvider } from "../../src/components/auth-config-provider";
import { LocaleProvider } from "../../src/components/locale-provider";
import { appPath, localPath } from "../../src/lib/app-path";

function Fixture() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const route = localPath(location.pathname);
  const params = new URLSearchParams(location.search);
  const preview = `/api/preview/fixture/${params.has("raw") ? "?raw=1" : ""}`;
  if (route.startsWith("/c/")) return <CollectionPage token={route.slice(3)} />;
  if (route.startsWith("/s/") || route.startsWith("/v/")) return <SharedCommentShell
    header={<header><AuthButton variant="avatar" /><h1>Artifact destination</h1></header>}
    comments={{ slug: "fixture", filePath: "index.html", scope: { siteId: "fixture", versionId: "ver_1", entry: route.startsWith("/v/") ? { kind: "share", shareId: "share_1" } : { kind: "main" } }, shareToken: route.startsWith("/v/") ? "share_1" : undefined }}>
    <iframe title="Preview" src={appPath(preview)} sandbox="allow-forms allow-modals allow-scripts allow-popups allow-downloads" />
  </SharedCommentShell>;
  if (params.has("presentation")) return <PresentationViewer title="Preview" src={preview} returnTo="/" />;
  const frame = <iframe ref={frameRef} title="Preview" src={appPath(preview)}
    sandbox="allow-forms allow-modals allow-scripts allow-popups allow-downloads" style={{ width: "100%", height: 400 }} />;
  if (params.has("share")) return <SharedCommentShell header={<header>Shared artifact</header>}
    comments={{ slug: "fixture", filePath: "index.html", scope: { siteId: "fixture", versionId: "ver_1", entry: { kind: "share", shareId: "share_1" } }, shareToken: "share_1" }}>
    {frame}
  </SharedCommentShell>;
  return <>
    {frame}
    <PreviewNavigation frameRef={frameRef} />
  </>;
}
createRoot(document.getElementById("root")!).render(<LocaleProvider locale="en"><AuthConfigProvider enabled hasSessionHint><Fixture /></AuthConfigProvider></LocaleProvider>);
