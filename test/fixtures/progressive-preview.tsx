import { useState } from "react";
import { createRoot } from "react-dom/client";
import ProgressivePreview from "../../src/components/progressive-preview";
import type { SiteSummary } from "../../src/lib/types";
const site = { slug:"fixture", title:"Preview fixture", kind:"single", takenDownAt: location.search.includes("removed") ? 1 : null } as SiteSummary;
function Fixture() {
  const [removed, setRemoved] = useState(site.takenDownAt);
  return <><button id="remove" onClick={() => setRemoved(1)}>Take down</button><button id="restore" onClick={() => setRemoved(null)}>Restore</button><ProgressivePreview site={{...site,takenDownAt:removed}} src="/content" /></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
