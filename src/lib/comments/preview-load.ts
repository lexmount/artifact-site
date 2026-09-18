/** Runs in the root head before any preview iframe is parsed, so hydration cannot miss its load event. */
export function installPreviewLoadTracker() {
  const host = window as Window & { __artifactPreviewLoads?: WeakSet<EventTarget> };
  if (host.__artifactPreviewLoads) return;
  const loaded = host.__artifactPreviewLoads = new WeakSet<EventTarget>();
  document.addEventListener("load", event => {
    if (event.target instanceof HTMLIFrameElement) loaded.add(event.target);
  }, true);
}
export const previewLoadTrackerScript = `(${installPreviewLoadTracker.toString()})();`;
export function previewAlreadyLoaded(frame: HTMLIFrameElement) {
  return (window as Window & { __artifactPreviewLoads?: WeakSet<EventTarget> }).__artifactPreviewLoads?.has(frame) ?? false;
}
export function resetPreviewLoad(frame: HTMLIFrameElement) {
  (window as Window & { __artifactPreviewLoads?: WeakSet<EventTarget> }).__artifactPreviewLoads?.delete(frame);
}
