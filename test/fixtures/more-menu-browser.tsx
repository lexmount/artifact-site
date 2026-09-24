import { createRoot } from "react-dom/client";
import MoreMenu from "../../src/components/more-menu";

createRoot(document.getElementById("root")!).render(
  <>
    <input id="outside" aria-label="Outside focus target" />
    <div id="trigger-rail" style={{ position: "absolute", top: 450, right: 10, width: "calc(100% - 20px)", overflowX: "auto" }}>
      <div id="trigger-track" style={{ display: "flex", justifyContent: "flex-end", width: "100%" }}>
        <MoreMenu label="Actions" iconOnly>
          <button role="menuitem" className="menu-item">Save latest version as a completely independent new site</button>
          <button role="menuitem" className="menu-item">Delete</button>
        </MoreMenu>
      </div>
    </div>
  </>,
);
