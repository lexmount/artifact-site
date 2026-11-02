/** Runs inside the existing sandbox. Messages only control host navigation visibility. */
function packageLocationRuntime(directory: boolean, parentOrigin: string) {
  const announce = () => parent.postMessage({ type: "artifact:package-location", directory }, parentOrigin);
  window.addEventListener("message", event => {
    if (event.source === parent && (parentOrigin === "*" || event.origin === parentOrigin) && event.data?.type === "artifact:package-location-request") announce();
  });
  window.addEventListener("pageshow", announce);
  document.addEventListener("DOMContentLoaded", announce, { once: true });
  // Deferred scripts may hold DOMContentLoaded and iframe load indefinitely.
  announce();
}
export function packageLocationBootstrap(directory: boolean, parentOrigin: string): string {
  const args = JSON.stringify([directory, parentOrigin]).replaceAll("<", "\\u003c");
  return `<script data-artifact-bootstrap>(${packageLocationRuntime.toString()})(...${args});</script>`;
}
