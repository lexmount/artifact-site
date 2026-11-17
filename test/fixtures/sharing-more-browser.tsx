import { createRoot } from "react-dom/client";
import { useLayoutEffect, useRef, useState } from "react";
import SharingMore from "../../src/components/sharing/sharing-more";

function Fixture() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState("");
  useLayoutEffect(() => {
    dialog.current!.showModal();
    dialog.current!.querySelector("h2")!.focus();
  }, []);
  return <dialog ref={dialog} className="sharing-dialog is-main">
    <header className="sharing-dialog-head">
      <h2 tabIndex={-1}>Share artifact</h2>
      <div className="share-window-actions">
        <SharingMore data={null} disabled={false} onMembers={() => setSelected("members")} onLinks={() => setSelected("links")} onFollow={() => setSelected("follow")} onStop={() => setSelected("stop")} />
        <button id="outside" type="button">Close</button>
      </div>
    </header>
    <div className="sharing-dialog-body" style={{ minHeight: 240 }}>
      <p id="outside-text" style={{ marginTop: 160 }}>Main link access</p>
      <output id="selected">{selected}</output>
    </div>
  </dialog>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
