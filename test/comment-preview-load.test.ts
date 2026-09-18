import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { previewLoadTrackerScript } from "@/lib/comments/preview-load";

describe("pre-hydration iframe load tracking", () => {
  it("records an early iframe load without treating newly inserted frames as loaded", () => {
    class Frame extends EventTarget {}
    const document = new EventTarget();
    const window: { __artifactPreviewLoads?: WeakSet<EventTarget> } = {};
    const context = { document, window, HTMLIFrameElement: Frame };
    runInNewContext(previewLoadTrackerScript, context);
    const frame = new Frame();
    const event = new Event("load");
    Object.defineProperty(event, "target", { value: frame });
    document.dispatchEvent(event);
    expect(window.__artifactPreviewLoads?.has(frame)).toBe(true);
    expect(window.__artifactPreviewLoads?.has(new Frame())).toBe(false);
    // Executing again during a subsequent share render preserves the existing tracker.
    const loaded = window.__artifactPreviewLoads;
    runInNewContext(previewLoadTrackerScript, context);
    expect(window.__artifactPreviewLoads).toBe(loaded);
  });
  it("ignores unrelated resource loads", () => {
    const document = new EventTarget();
    const window: { __artifactPreviewLoads?: WeakSet<EventTarget> } = {};
    runInNewContext(previewLoadTrackerScript, { document, window, HTMLIFrameElement: class {} });
    document.dispatchEvent(new Event("load"));
    expect(window.__artifactPreviewLoads?.has(document)).toBe(false);
  });
});
