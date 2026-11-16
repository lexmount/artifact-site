import { appBasePath } from "@/lib/app-path";

/** Shared by the host and serialized bootstrap. Only read-only platform routes cross the boundary. */
export function platformDestination(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\\]/.test(value)) return null;
  const match = /^(\/(?:me|explore)?|\/(?:c|s|v)\/[A-Za-z0-9_-]{1,128})(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
  if (!match) return null;
  const path = match[1];
  if (path === "/" || path === "/me" || path === "/explore") return path;
  const supplied = new URLSearchParams(match[2]), query = new URLSearchParams();
  const collection = path.startsWith("/c/");
  const keys = collection ? ["folder", "q"] : [...(path.startsWith("/s/") ? ["version", "collection", "presentation"] : ["version", "presentation"]), "thread", "message", "comments"];
  for (const key of keys) {
    const entry = supplied.get(key);
    if (!entry) continue;
    if (key === "q" ? entry.length <= 512 && !/[\u0000-\u001f\u007f]/.test(entry)
      : key === "presentation" ? entry === "1" : key === "comments" ? entry === "1" || entry === "all" : /^[A-Za-z0-9_-]{1,128}$/.test(entry)) query.set(key, entry);
  }
  const search = query.toString();
  const comment = collection ? null : new URLSearchParams(match[3]).get("comment");
  const hash = comment && /^[A-Za-z0-9_-]{1,128}$/.test(comment) ? `#comment=${comment}` : "";
  return path + (search ? `?${search}` : "") + hash;
}

/** Runs inside the opaque frame; the host still treats every message as untrusted. */
function navigationRuntime(mount: string, destination: typeof platformDestination) {
  const embedded = parent !== window;
  const platformOrigin = new URL(document.baseURI).origin;
  let enabled = false;
  if (embedded) {
    window.addEventListener("message", event => {
      if (event.source === parent && event.origin === platformOrigin && event.data?.type === "artifact:platform-navigation-enabled") enabled = true;
    });
    parent.postMessage({ type: "artifact:platform-navigation-ready" }, platformOrigin);
  }

  function linkIn(event: MouseEvent): Element | null {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const node of path) {
      if (node instanceof Element && ["A", "AREA"].includes(node.tagName.toUpperCase()) && node.hasAttribute("href")) return node;
    }
    const target = event.target instanceof Element ? event.target.closest("a[href],area[href]") : null;
    return target instanceof Element ? target : null;
  }

  // Native activation can dispatch popstate synchronously, before the cleanup timer.
  // Restore authored attributes before artifact history handlers (including capture handlers).
  const pendingRestores = new Set<() => void>();
  const restoreFragments = () => [...pendingRestores].forEach(restore => restore());
  window.addEventListener("popstate", restoreFragments, true);
  window.addEventListener("hashchange", restoreFragments, true);

  // Correct the URL at the end of dispatch, before native activation. Register tail listeners
  // during capture so existing artifact handlers see their original href and get first refusal.
  // If an element stops propagation, its tail performs the same correction there. We do not
  // override stopImmediatePropagation or window-capture propagation stops: those handlers
  // prevent our tail from running, so their native behavior remains under artifact control.
  // Native activation retains focus, :target, named anchors, repeated fragments and history.
  window.addEventListener("click", event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = linkIn(event);
    if (!link || link.hasAttribute("download")) return;
    const browsingTarget = link.getAttribute("target") || document.querySelector("base[target]")?.getAttribute("target");
    if (browsingTarget && browsingTarget.toLowerCase() !== "_self") return;
    const raw = link.getAttribute("href") || "";
    if (!raw.trim().startsWith("#")) return;
    let corrected: string | null = null;
    const removals: Array<() => void> = [];
    const restore = () => {
      if (!pendingRestores.delete(restore)) return;
      if (corrected !== null && link.getAttribute("href") === corrected) link.setAttribute("href", raw);
    };
    // Schedule cleanup before installing tails, including if listener setup throws partway.
    setTimeout(() => {
      removals.forEach(remove => remove());
      restore();
    }, 0);
    const finish = (current: Event) => {
      if (current !== event || corrected !== null || event.defaultPrevented) return;
      if (!event.cancelBubble && current.currentTarget !== window) return;
      // An artifact handler may intentionally replace href; never replace that decision.
      if (link.getAttribute("href") !== raw) return;
      const target = link.getAttribute("target") || document.querySelector("base[target]")?.getAttribute("target");
      if (link.hasAttribute("download") || (target && target.toLowerCase() !== "_self")) return;
      corrected = new URL(raw, location.href).href;
      pendingRestores.add(restore);
      link.setAttribute("href", corrected);
    };
    for (const node of event.composedPath()) {
      // The window capture listener list is already being dispatched; its bubble tail suffices.
      for (const capture of node === window ? [false] : [true, false]) {
        const tail = (current: Event) => finish(current);
        node.addEventListener("click", tail, capture);
        removals.push(() => node.removeEventListener("click", tail, capture));
      }
    }
  }, true);

  const platformClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.altKey || (event.type === "auxclick" ? event.button !== 1 : event.button !== 0)) return;
    const target = linkIn(event);
    if (!target || target.hasAttribute("download")) return;
    const browsingTarget = target.getAttribute("target") || document.querySelector("base[target]")?.getAttribute("target");
    if (!embedded || !enabled || !(target instanceof HTMLAnchorElement)) return;
    try {
      const base = new URL(document.baseURI), url = new URL(target.href, base);
      if (url.origin !== base.origin || url.username || url.password) return;
      const local = !mount ? url.pathname : url.pathname === mount ? "/" : url.pathname.startsWith(`${mount}/`) ? url.pathname.slice(mount.length) : null;
      const path = local === null ? null : destination(local + url.search + url.hash);
      if (!path) return;
      event.preventDefault();
      const newTab = Boolean(event.button === 1 || event.metaKey || event.ctrlKey || event.shiftKey ||
        (browsingTarget && !["_self", "_parent", "_top"].includes(browsingTarget.toLowerCase())));
      // Native popups inherit the opaque sandbox even after reload. The host asks the reader
      // to continue, then performs the navigation from its own origin without an opener.
      parent.postMessage({ type: "artifact:platform-navigation", path, newTab }, base.origin);
    } catch { /* Invalid links retain browser behavior. */ }
  };
  // Install tails before artifact handlers run, as with fragment correction above. A
  // propagation stop must not leave native popups to inherit the preview's opaque origin;
  // handlers on that same node still get to cancel activation before the tail runs.
  const preparePlatformClick = (event: MouseEvent) => {
    if (!embedded || !enabled || event.defaultPrevented || event.altKey ||
      (event.type === "auxclick" ? event.button !== 1 : event.button !== 0)) return;
    const target = linkIn(event);
    if (!(target instanceof HTMLAnchorElement) || target.hasAttribute("download")) return;
    let handled = false;
    const removals: Array<() => void> = [];
    setTimeout(() => removals.forEach(remove => remove()), 0);
    for (const node of event.composedPath()) {
      for (const capture of node === window ? [false] : [true, false]) {
        const tail = (current: Event) => {
          if (current !== event || handled || (!event.cancelBubble && current.currentTarget !== window)) return;
          handled = true;
          platformClick(event);
        };
        node.addEventListener(event.type, tail, capture);
        removals.push(() => node.removeEventListener(event.type, tail, capture));
      }
    }
  };
  window.addEventListener("click", preparePlatformClick, true);
  window.addEventListener("auxclick", preparePlatformClick, true);
}

export function previewNavigationBootstrap(mount = appBasePath()): string {
  return `<script data-artifact-bootstrap>(${navigationRuntime.toString()})(${JSON.stringify(mount).replace(/</g, "\\u003c")},${platformDestination.toString()});</script>`;
}
