export const PREVIEW_INTERACTION_EVENT = "artifact:preview-interaction";

/** A read-only signal: host notices may dismiss without intercepting artifact input. */
function interactionRuntime(type: string) {
  if (parent === window) return;
  const origin = new URL(document.baseURI).origin;
  window.addEventListener("pointerdown", () => parent.postMessage({ type }, origin), { capture: true, passive: true });
  window.addEventListener("keydown", event => {
    if (event.key === "Escape") parent.postMessage({ type }, origin);
  }, true);
}

export function previewInteractionBootstrap(): string {
  return `<script data-artifact-bootstrap>(${interactionRuntime.toString()})(${JSON.stringify(PREVIEW_INTERACTION_EVENT)});</script>`;
}
