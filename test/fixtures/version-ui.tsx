import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import VersionUpload from "../../src/components/version-upload";
import { useLearnHint } from "../../src/lib/use-learn-hint";
import VisibilityChip from "../../src/components/visibility-chip";
import Coachmark from "../../src/components/coachmark";
import { LocaleProvider } from "../../src/components/locale-provider";
function Fixture() {
  const [open, setOpen] = useState(false);
  const learn = useLearnHint();
  const firstLearn = useRef(learn);
  useEffect(() => { document.body.dataset.stableLearn = String(firstLearn.current === learn); }, [learn]);
  const params = new URLSearchParams(location.search);
  return <><button id="upload" onClick={() => setOpen(true)}>Upload</button><button id="hint">Private</button><button id="learn" onClick={() => learn("test")}>Learn</button><VisibilityChip visibility="unlisted" /><VisibilityChip visibility="private" contextualHint />
    <Coachmark name="test" selector="#hint" seconds={1} manual text="Private link guidance" />
    {open && <VersionUpload target={{ slug: params.get("slug")!, title: "季度报告", kind: "single", token: params.get("token"), canOfficial: true }} onClose={() => setOpen(false)} onPublished={() => { document.body.dataset.published = "true"; }} />}
  </>;
}
createRoot(document.getElementById("root")!).render(<LocaleProvider locale="zh-CN"><Fixture /></LocaleProvider>);
