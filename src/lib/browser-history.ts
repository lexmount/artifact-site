/** Update the URL through Next's history wrapper while retaining app return context.
 * Passing framework markers would bypass router URL synchronization.
 */
export function replaceBrowserUrl(url: string | URL): void {
  const state = window.history.state;
  const context: Record<string, unknown> = {};
  for (const key of ["artifactViewerReturn", "artifactReturnTo"]) {
    if (state && Object.hasOwn(state, key)) context[key] = state[key];
  }
  window.history.replaceState(context, "", url);
}
