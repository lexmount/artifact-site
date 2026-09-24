import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import ConfirmDialog from "../../src/components/confirm-dialog";
import PreviewNavigation from "../../src/components/preview-navigation";
import { useSiteActions } from "../../src/lib/site-actions";
import { LocaleProvider } from "../../src/components/locale-provider";

function Fixture() {
  const [generation, setGeneration] = useState(0);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const actions = useSiteActions({});
  return <>
    <button id="reload" onClick={() => setGeneration(n => n + 1)}>Reload preview</button>
    <button id="delete" onClick={() => actions.remove("fixture", "季度研究报告 — Quarterly report")}>Delete</button>
    {actions.deleteRequest && <ConfirmDialog title={`Delete "${actions.deleteRequest.title}"?`} body="This site will no longer be accessible."
      confirmLabel="Delete site" danger onConfirm={actions.confirmDelete} onClose={actions.cancelDelete} />}
    <iframe key={generation} ref={frameRef} title="Artifact" src={new URLSearchParams(location.search).get("preview")!}
      sandbox="allow-forms allow-modals allow-scripts allow-popups allow-downloads" style={{ width: "100%", height: 600 }} />
    <PreviewNavigation frameRef={frameRef} />
  </>;
}
createRoot(document.getElementById("root")!).render(<LocaleProvider locale="en"><Fixture /></LocaleProvider>);
