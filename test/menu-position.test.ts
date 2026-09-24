import { describe, expect, it } from "vitest";
import { menuPosition } from "@/lib/menu-position";

const desktop = { left: 0, top: 0, width: 800, height: 600 };

describe("action menu viewport placement", () => {
  it("opens below the trigger when all actions fit", () => {
    expect(menuPosition({ top: 40, bottom: 72, right: 790 }, 220, 280, desktop))
      .toEqual({ top: 78, left: 570, maxHeight: 584, maxWidth: 784 });
  });

  it("keeps the final Delete action visible for the bottom row", () => {
    const pos = menuPosition({ top: 450, bottom: 482, right: 790 }, 220, 280, desktop);
    expect(pos.top).toBe(164);
    expect(pos.top + 280).toBeLessThanOrEqual(592);
  });

  it("clamps tall menus within a short viewport for internal scrolling", () => {
    const pos = menuPosition({ top: 110, bottom: 142, right: 310 }, 220, 400,
      { left: 0, top: 0, width: 320, height: 240 });
    expect(pos.top).toBe(8);
    expect(pos.maxHeight).toBe(224);
  });

  it("keeps menus near the left edge on screen", () => {
    const pos = menuPosition({ top: 40, bottom: 72, right: 32 }, 220, 100,
      { ...desktop, width: 320 });
    expect(pos.left).toBe(8);
  });

  it("repositions after shrinking the viewport", () => {
    const anchor = { top: 300, bottom: 332, right: 790 };
    expect(menuPosition(anchor, 220, 200, { ...desktop, height: 700 }).top).toBe(338);
    expect(menuPosition(anchor, 220, 200, { ...desktop, height: 400 }).top).toBe(94);
  });

  it("respects the offset and bounds of a panned visual viewport", () => {
    const viewport = { left: 100, top: 200, width: 320, height: 300 };
    const pos = menuPosition({ top: 420, bottom: 452, right: 450 }, 220, 180, viewport);
    expect(pos).toEqual({ top: 234, left: 192, maxHeight: 284, maxWidth: 304 });
    expect(menuPosition({ top: 420, bottom: 452, right: 120 }, 220, 180, viewport).left).toBe(108);
  });

  it("limits menu height to the area above the software keyboard", () => {
    const viewport = { left: 0, top: 0, width: 390, height: 180 };
    const pos = menuPosition({ top: 140, bottom: 172, right: 380 }, 220, 400, viewport);
    expect(pos.top).toBe(8);
    expect(pos.maxHeight).toBe(164);
    expect(pos.top + pos.maxHeight).toBe(172);
  });

  it("constrains menu width in a narrow zoomed viewport", () => {
    const pos = menuPosition({ top: 110, bottom: 142, right: 350 }, 220, 400,
      { left: 200, top: 80, width: 160, height: 200 });
    expect(pos.left).toBe(208);
    expect(pos.maxWidth).toBe(144);
    expect(pos.top).toBe(88);
  });
});
