import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import MoreMenu from "@/components/more-menu";

afterEach(() => vi.unstubAllGlobals());

it("keeps the server snapshot portal-free even when browser globals are present", () => {
  const props = {
    label: "More", iconOnly: true,
    children: createElement("button", { role: "menuitem" }, "Download"),
  };
  const render = () => renderToString(createElement(MoreMenu, props));
  const server = render();
  // Hydration must choose the server snapshot, not the presence of document. The previous
  // typeof-document branch attempts a portal here, which React's server renderer rejects.
  vi.stubGlobal("document", { body: { nodeType: 1 } });
  expect(render()).toBe(server);
  expect(server).toContain('aria-haspopup="menu"');
  expect(server).not.toContain("Download");
});
