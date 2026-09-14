// The "publish the page I am looking at" bookmarklet — the script itself and its landing-page contract.
//
// Why the detour is unavoidable: two hard browser rules block every direct route.
//   · A local-file page cannot call our API directly — its origin is the string `null`, and a
//     cross-origin request with cookies requires the server to answer with a concrete origin. The
//     only value we could put there is `null`, but `null` is not exclusive to file://: sandboxed
//     iframes and data: pages are all `null` too. Allowing it would open a back door to every sandboxed page.
//   · Nor can our page read the disk the other way round — an https page fetching file:// is flatly
//     forbidden by the browser.
//
// So the windows talk to each other instead. The key point is that this script never "reads a file":
// it only serializes the **DOM already rendered on screen** — the browser read the file long ago, so
// no filesystem permission is needed at all. The content is postMessage'd to the landing page, which
// lives on our own domain where the cookie already is, so publishing is a same-origin request.

/** The landing route. The bookmarklet sends the content here, and this page renders the confirmation. */
export const BOOKMARKLET_TARGET_PATH = "/publish-from-page";

/** A single HTML page is at most this order of magnitude; anything bigger is most likely a mistake (a whole-site export, tens of MB of inlined base64). */
export const MAX_PAGE_BYTES = 12 * 1024 * 1024;

/**
 * Squeezed onto one line, because it ultimately has to live inside a `javascript:` URL. Several things are deliberate:
 *   · Add the doctype — `outerHTML` does not include it, and without it the page falls into quirks
 *     mode and the layout changes completely.
 *   · **Measure the size before opening the window** — over the limit, an opened window would only
 *     wait in vain (the landing page silently drops oversized payloads, which is the right posture
 *     for it: a message on that channel is not necessarily from this bookmarklet). So say so at the
 *     source, instead of leaving the user staring at "Waiting for page content…" guessing whether
 *     it is too big or broken.
 *   · Wait for the other side to say ready before sending — right after open, nobody in the new
 *     window is listening yet, and a message sent then vanishes silently.
 *   · Target our exact origin in the message, not `'*'` — broadcasting would read the whole page out
 *     to any window that is listening.
 *   · **Report a timeout when ready never arrives** — if the page set
 *     `Cross-Origin-Opener-Policy: same-origin`, the new window's `window.opener` is severed and
 *     that ready message can never be sent. This failure has no symptom at all (unlike a blocked
 *     popup, which is obvious on the spot); without a backstop, the click simply does nothing.
 *   · The whole script must not contain `#` — the browser truncates everything after it as a
 *     fragment, leaving the script mangled.
 */
export function bookmarkletSource(origin: string): string {
  const target = JSON.stringify(origin);
  const mb = Math.round(MAX_PAGE_BYTES / 1024 / 1024);
  return `javascript:(function(){var T=${target};var d=document.doctype;var H=(d?'<!doctype '+d.name+'>':'')+document.documentElement.outerHTML;if(new Blob([H]).size>${MAX_PAGE_BYTES}){alert('This page is over ${mb}MB and cannot be sent. Try dragging the file or the whole folder onto the artifact-site home page');return}var w=window.open(T+'${BOOKMARKLET_TARGET_PATH}','_blank');if(!w){alert('The browser blocked the popup. Allow it and click again');return}var p={__artifactHubPage:{html:H,title:document.title||'',url:location.href}};var s=0;function h(e){if(e.data&&e.data.__artifactHubReady){w.postMessage(p,T);s=1;window.removeEventListener('message',h)}}window.addEventListener('message',h);setTimeout(function(){if(!s){window.removeEventListener('message',h);alert('This website does not allow pages to talk to each other, so it cannot be published from here. Drag the file onto the artifact-site home page instead')}},6000)})()`;
}
