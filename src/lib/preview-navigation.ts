/** Only fixed, read-only platform destinations cross the preview boundary. */
export function platformDestination(value: unknown): "/" | "/me" | "/explore" | null {
  return value === "/" || value === "/me" || value === "/explore" ? value : null;
}

/** Runs inside the opaque frame; the host still treats every message as untrusted. */
function navigationRuntime() {
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

  window.addEventListener("click", event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = linkIn(event);
    if (!target || target.hasAttribute("download")) return;
    const browsingTarget = target.getAttribute("target") || document.querySelector("base[target]")?.getAttribute("target");
    if (browsingTarget && browsingTarget.toLowerCase() !== "_self") return;
    if (!embedded || !enabled || !(target instanceof HTMLAnchorElement)) return;
    try {
      const base = new URL(document.baseURI), url = new URL(target.href, base);
      if (url.origin !== base.origin || url.username || url.password || !["/", "/me", "/explore"].includes(url.pathname)) return;
      event.preventDefault();
      // No credentials or arbitrary URLs leave the frame. The host asks the reader to continue.
      parent.postMessage({ type: "artifact:platform-navigation", path: url.pathname }, base.origin);
    } catch { /* Invalid links retain browser behavior. */ }
  });
}

export function previewNavigationBootstrap(): string {
  return `<script data-artifact-bootstrap>(${navigationRuntime.toString()})();</script>`;
}
