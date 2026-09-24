import { COMMENT_LOCATION_FLASH_MS } from "./contracts";
import { canonicalPreviewPath } from "./preview-path";
import type { CommentAnchor, CommentScope, PreviewCommentCommand, PreviewCommentEvent } from "./contracts";

/** Runs inside the existing opaque-origin sandbox, never in the host document. */
function commentPreviewRuntime(filePath: string, parentOrigin: string, documentMode: boolean, flashMs: number, canonicalPath: (input: string) => string | null) {
  type Marker = { threadId: string; anchor: CommentAnchor };
  let channelId = "";
  let scope: CommentScope | null = null;
  let selecting = false;
  let textSelectionEnabled = false;
  let textSelectionLabel = "";
  let selectionCandidate: CommentAnchor | null = null;
  let selectionCache: { start: Node; startOffset: number; end: Node; endOffset: number; anchor: CommentAnchor } | null = null;
  const selectionButton = document.createElement("button");
  selectionButton.type = "button";
  selectionButton.dataset.commentSelection = "true";
  selectionButton.style.cssText = "display:none;position:absolute;pointer-events:auto;padding:7px 12px;min-height:44px;border:0;border-radius:18px;background:#fff;color:#36502a;font:600 14px system-ui;box-shadow:0 2px 6px #0003;cursor:pointer;max-width:calc(100vw - 16px)";

  let markers: Marker[] = [];
  let temporary: Marker | null = null;
  let visible = false;
  let suppressClick = false;
  let down: { element: Element; x: number; y: number } | null = null;
  let hovered: Element | null = null;
  let raf = 0;
  let focusedAnchor: CommentAnchor | null = null;
  let locatedAt = 0;
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  const layer = document.createElement("div");
  layer.dataset.artifactCommentOverlay = "true";
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646;overflow:hidden";
  const highlight = document.createElement("div");
  highlight.style.cssText = "position:absolute;border:2px solid #557341;background:rgba(85,115,65,.08);display:none;pointer-events:none";
  const pins = document.createElement("div");
  layer.append(highlight, pins);
  const style = document.createElement("style");
  // The cursor is a self-contained SVG, no request or credential is involved.
  const cursorSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="M7 24l-2 5 7-3c13 4 22-12 12-20C13-3 0 8 5 19z" fill="white" stroke="#557341" stroke-width="2" stroke-linejoin="round"/><path d="M11 14h10m-5-5v10" stroke="#557341" stroke-width="2" stroke-linecap="round"/></svg>';
  style.textContent = `html[data-artifact-comment-select],html[data-artifact-comment-select] *{cursor:url("data:image/svg+xml,${encodeURIComponent(cursorSvg)}") 5 29,crosshair!important}@keyframes artifact-comment-locate{0%,33.333%{opacity:1}100%{opacity:0}}`;
  function mount() { if (!layer.isConnected) document.documentElement.append(layer, style); }
  function emit(event: PreviewCommentEvent["event"]) {
    if (!scope || !channelId) return;
    parent.postMessage({ protocol: "artifact-comments", schemaVersion: 1, channelId, scope, event }, parentOrigin);
  }
  // DOM readiness is enough for element anchors; images and fonts may still be loading.
  document.addEventListener("DOMContentLoaded", () => emit({ type: "ready", filePath }), { once: true });
  function cancel(notify = false) {
    selectionButton.remove(); selectionCandidate = null; selectionCache = null;
    selecting = false; down = null; hovered = null; focusedAnchor = null; clearTimeout(focusTimer);
    delete document.documentElement.dataset.artifactCommentSelect;
    highlight.style.display = "none";
    if (notify) emit({ type: "cancelled" });
  }
  function box(rect: { left: number; top: number; width: number; height: number }) {
    Object.assign(highlight.style, { display: "block", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }
  function rotation(el: Element) { return ((Number((el as HTMLElement).dataset.commentRotation) || 0) % 360 + 360) % 360; }
  function turn(p: { x: number; y: number }, angle: number) {
    if (angle === 90) return { x: p.y, y: 1 - p.x };
    if (angle === 180) return { x: 1 - p.x, y: 1 - p.y };
    if (angle === 270) return { x: 1 - p.y, y: p.x };
    return p;
  }
  function imageBox(el: HTMLImageElement) {
    const r = el.getBoundingClientRect();
    const css = getComputedStyle(el);
    // object-fit contain can introduce padding inside the image's own CSS box.
    if (css.objectFit === "contain" && el.naturalWidth && el.naturalHeight) {
      const scale = Math.min(r.width / el.naturalWidth, r.height / el.naturalHeight);
      const width = el.naturalWidth * scale, height = el.naturalHeight * scale;
      return { left: r.left + (r.width - width) / 2, top: r.top + (r.height - height) / 2, width, height };
    }
    return r;
  }
  function bounds(el: Element) { return el instanceof HTMLImageElement ? imageBox(el) : el.getBoundingClientRect(); }
  function point(el: Element, x: number, y: number) {
    const r = bounds(el);
    if (r.width <= 0 || r.height <= 0) return null;
    const p = { x: (x - r.left) / r.width, y: (y - r.top) / r.height };
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return null;
    return turn(p, rotation(el));
  }
  function relativeImage(el: HTMLImageElement) {
    try {
      const url = new URL(el.currentSrc || el.src), base = new URL(document.baseURI);
      if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return null;
      const value = decodeURIComponent(url.pathname.slice(base.pathname.length));
      return canonicalPath(value);
    } catch { return null; }
  }
  function selector(el: Element) {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.documentElement && parts.join(">").length < 1800) {
      // Positional selectors avoid putting potentially sensitive ID/attribute values in messages.
      const tag = node.tagName.toLowerCase();
      const siblings: Element[] = node.parentElement ? Array.from(node.parentElement.children).filter(x => x.tagName === node!.tagName) : [];
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(node) + 1})`);
      node = node.parentElement;
    }
    return `html>${parts.join(">")}`;
  }
  const excluded = "input,textarea,select,form,button,[contenteditable],[hidden],[aria-hidden='true'],script,style,noscript,template,[data-artifact-comment-overlay]";
  type TextPoint = { node: Node; offset: number };
  // One bounded text representation for excerpts, selection context and relocation.
  // Keep DOM offsets so block/BR separators do not change the actual selected range.
  function textIndex(el: Element, limit = 100000, legacy = false) {
    let text = "", visited = 0;
    // Read-only compatibility with element quotes saved before text selection existed.
    const omissions = legacy ? "input,textarea,select,form,[hidden],[aria-hidden='true'],script,style,noscript,template,[data-artifact-comment-overlay]" : excluded;
    const points: (TextPoint | null)[] = [];
    const displays = new Map<Element, string>();
    const display = (node: Element) => {
      if (!displays.has(node)) displays.set(node,getComputedStyle(node).display);
      return displays.get(node)!;
    };
    const blockBoundary = (node: Element) => node.tagName === "BR" ||
      /^(block|flow-root|list-item|flex|grid|table(?:-.*)?)(?:\s|$)/.test(display(node));
    const append = (char: string, point: TextPoint | null) => {
      if (text.length >= limit || (char === " " && (!text || text.endsWith(" ")))) return;
      text += char; points.push(point);
    };
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: node => node instanceof Element && (node.matches(omissions) || (!legacy && display(node) === "none")) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    if (el.closest(omissions)) return { text, points };
    let node: Node | null, previousBlock: Element | null = null;
    while ((node = walker.nextNode()) && text.length < limit && ++visited < 10000) {
      if (node instanceof Element) {
        if (!legacy && blockBoundary(node)) append(" ", null);
        continue;
      }
      let block = node.parentElement;
      while (!legacy && block && block !== el && !blockBoundary(block)) block = block.parentElement;
      if (!legacy && previousBlock && block !== previousBlock) append(" ", null);
      previousBlock = block;
      const value = node.textContent || "";
      for (let offset = 0; offset < value.length && text.length < limit; offset++) {
        append(/\s/.test(value[offset]) ? " " : value[offset], { node, offset });
      }
    }
    return { text, points };
  }
  function visibleText(el: Element, limit = 2000) {
    return textIndex(el, limit).text.trim();
  }
  function candidate(el: Element, start: { x: number; y: number }, end: { x: number; y: number }): CommentAnchor | null {
    const page = Number((el as HTMLElement).dataset.commentPage);
    const pdf = canonicalPath((el as HTMLElement).dataset.commentFile ?? "");
    const image = el instanceof HTMLImageElement ? relativeImage(el) : null;
    if ((page && pdf) || image) {
      const a = point(el, start.x, start.y), b = point(el, end.x, end.y);
      if (!a || !b) return null;
      const region = Math.hypot(start.x - end.x, start.y - end.y) < 5
        ? { kind: "point" as const, point: b }
        : { kind: "rect" as const, rect: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) } };
      if (region.kind === "rect" && (!region.rect.width || !region.rect.height)) return null;
      if (page && pdf) return { schemaVersion: 1, kind: "pdf", filePath: pdf, page, region };
      if (image) return { schemaVersion: 1, kind: "image", filePath: image, region };
    }
    // Document wrappers have no meaningful HTML target; failed Office conversion stays whole-file.
    if (documentMode || document.getElementById("doc-config") || document.querySelector("meta[name='artifact-document']")) return { schemaVersion: 1, kind: "document", filePath };
    const r = el.getBoundingClientRect();
    const width = Math.max(document.documentElement.scrollWidth, innerWidth);
    const height = Math.max(document.documentElement.scrollHeight, innerHeight);
    const x = Math.max(0, (r.left + scrollX) / width), y = Math.max(0, (r.top + scrollY) / height);
    const rect = { x, y, width: Math.min(r.width / width, 1 - x), height: Math.min(r.height / height, 1 - y) };
    const text = visibleText(el);
    return { schemaVersion: 1, kind: "html", filePath, selector: selector(el), ...(text ? { quote: { exact: text } } : {}),
      ...(rect.width > 0 && rect.height > 0 ? { rect } : {}), viewport: { width: innerWidth, height: innerHeight } };
  }
  // Passive text selection never steals pointer events from the artifact. Only the explicit
  // floating button sends an untrusted candidate; the host and API still authorize creation.
  let selectionPointer: { x: number; y: number; range: Range } | null = null;
  function selectedText() {
    selectionCandidate = null; selectionButton.remove();
    if (!textSelectionEnabled || selecting || !scope) return;
    const selection = getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
    const range = selection.getRangeAt(0);
    const element = (node: Node) => node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
    const start = element(range.startContainer), end = element(range.endContainer);
    if (!start || !end || layer.contains(start) || layer.contains(end) || start.closest(excluded) || end.closest(excluded)) return;
    const exact = selection.toString().replace(/\s+/g," ").trim();
    if (!exact || exact.length > 2000) return;
    const rect = range.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight) return;
    const pdfLayer = start.closest<HTMLElement>("[data-comment-text-page]");
    const cached = selectionCache;
    if (cached && cached.start === range.startContainer && cached.startOffset === range.startOffset &&
        cached.end === range.endContainer && cached.endOffset === range.endOffset) {
      selectionCandidate = cached.anchor;
    } else if (pdfLayer) {
      if (end.closest("[data-comment-text-page]") !== pdfLayer) return;
      const canvas = pdfLayer.parentElement?.querySelector<HTMLCanvasElement>("canvas[data-comment-page]");
      if (!canvas) return;
      const b = bounds(canvas);
      const anchor = candidate(canvas, {x:Math.max(b.left,rect.left),y:Math.max(b.top,rect.top)}, {x:Math.min(b.left+b.width,rect.right),y:Math.min(b.top+b.height,rect.bottom)});
      if (anchor?.kind === "pdf") selectionCandidate = {...anchor, quote:{exact}};
    } else {
      if (documentMode) return;
      const common = element(range.commonAncestorContainer);
      if (!common || common === document.documentElement || common.closest(excluded)) return;
      const anchor = candidate(common,{x:rect.left,y:rect.top},{x:rect.right,y:rect.bottom});
      if (anchor?.kind === "html") {
        const { text, points } = textIndex(common);
        const indices = points.flatMap((point, i) => point ? [i] : []);
        // DOM positions are ordered. Two binary searches avoid up to 100k comparePoint calls.
        const boundary = (after: boolean) => {
          let low = 0, high = indices.length;
          while (low < high) {
            const mid = (low + high) >>> 1, point = points[indices[mid]]!;
            let relation = range.comparePoint(point.node, point.offset);
            if (point.node === range.endContainer && point.offset === range.endOffset) relation = 1;
            if (after ? relation <= 0 : relation < 0) low = mid + 1;
            else high = mid;
          }
          return low;
        };
        const from = boundary(false), to = boundary(true);
        if (from >= to) return;
        const first = indices[from], last = indices[to - 1];
        const selected = text.slice(first, last + 1).trim();
        // Reject selections containing excluded content or beyond the bounded index.
        if (selected !== exact) return;
        selectionCandidate = {...anchor,quote:{exact:selected,prefix:text.slice(0,first).trimEnd().slice(-200),suffix:text.slice(last+1).trimStart().slice(0,200)}};
      }
    }
    if (!selectionCandidate) return;
    selectionCache = { start: range.startContainer, startOffset: range.startOffset,
      end: range.endContainer, endOffset: range.endOffset, anchor: selectionCandidate };
    selectionButton.textContent = textSelectionLabel;
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("width", "16"); icon.setAttribute("height", "16"); icon.setAttribute("aria-hidden", "true");
    icon.style.cssText = "vertical-align:-3px;margin-right:6px";
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M21 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-4-.9L3 21l1.9-5.5a9 9 0 0 1-.9-4A8.5 8.5 0 0 1 12.5 3h.5a8.5 8.5 0 0 1 8 8v.5Z");
    path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "1.8"); path.setAttribute("stroke-linejoin", "round");
    icon.append(path); selectionButton.prepend(icon);
    selectionButton.setAttribute("aria-label", textSelectionLabel);
    selectionButton.style.display = "block";
    layer.append(selectionButton);
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
    const pointer = selectionPointer;
    const atPointer = pointer && pointer.range.startContainer === range.startContainer && pointer.range.startOffset === range.startOffset && pointer.range.endContainer === range.endContainer && pointer.range.endOffset === range.endOffset;
    selectionButton.style.left = Math.max(left+8,Math.min(atPointer ? pointer.x : rect.left,left+width-selectionButton.offsetWidth-8))+"px";
    selectionButton.style.top = Math.max(top+8,Math.min((atPointer ? pointer.y : rect.bottom)+8,top+height-selectionButton.offsetHeight-8))+"px";
  }
  let selectionTimer: ReturnType<typeof setTimeout> | undefined;
  const updateSelection = () => { clearTimeout(selectionTimer); selectionTimer=setTimeout(selectedText,80); };
  document.addEventListener("selectionchange",updateSelection);
  document.addEventListener("pointerdown", event => {
    if (!selectionButton.contains(event.target as Node)) selectionPointer = null;
  });
  document.addEventListener("pointerup", event => {
    if (selectionButton.contains(event.target as Node)) return;
    const selection = getSelection();
    selectionPointer = event.pointerType === "mouse" && selection?.rangeCount === 1 && !selection.isCollapsed
      ? { x: event.clientX, y: event.clientY, range: selection.getRangeAt(0).cloneRange() } : null;
    updateSelection();
  });
  document.addEventListener("keydown", event => {
    if (!selectionButton.contains(event.target as Node)) selectionPointer = null;
  });
  const scrollSelection = () => { selectionPointer = null; updateSelection(); };
  addEventListener("scroll",scrollSelection,true);
  const resizeSelection = () => { selectionPointer = null; selectionCache = null; htmlLocations.clear(); textLocations.clear(); updateSelection(); };
  addEventListener("resize",resizeSelection);
  window.visualViewport?.addEventListener("resize",resizeSelection);
  window.visualViewport?.addEventListener("scroll",scrollSelection);
  selectionButton.addEventListener("pointerdown",event=>event.preventDefault());
  selectionButton.addEventListener("click",event=>{
    event.preventDefault(); event.stopPropagation();
    if (!textSelectionEnabled || !selectionCandidate) return;
    const anchor=selectionCandidate;
    const rect = selectionButton.getBoundingClientRect();
    cancel(); getSelection()?.removeAllRanges(); emit({type:"text-selected",anchor,position:{x:rect.left,y:rect.bottom}});
  });
  selectionButton.addEventListener("keydown",event=>{
    if(event.key==="Escape"){event.preventDefault();cancel();}
  });
  function target(event: PointerEvent) {
    const el = event.target instanceof Element ? event.target : null;
    if (!el || layer.contains(el) || el === document.documentElement) return null;
    return el.closest("[data-comment-text-page]")?.parentElement?.querySelector("canvas[data-comment-page]") || el.closest("canvas[data-comment-page]") || el;
  }
  document.addEventListener("pointerdown", e => {
    if (!selecting || e.button !== 0) return;
    const el = target(e); if (!el) return;
    e.preventDefault(); e.stopImmediatePropagation();
    suppressClick = true;
    down = { element: el, x: e.clientX, y: e.clientY };
  }, true);
  document.addEventListener("pointermove", e => {
    if (!selecting) return;
    const el = down?.element || target(e); if (!el) return;
    hovered = el;
    if (down && (el instanceof HTMLImageElement || (el as HTMLElement).dataset.commentPage)) {
      const r = bounds(el);
      const x = Math.max(r.left, Math.min(e.clientX, r.left + r.width));
      const y = Math.max(r.top, Math.min(e.clientY, r.top + r.height));
      box({ left: Math.min(down.x, x), top: Math.min(down.y, y), width: Math.abs(down.x - x), height: Math.abs(down.y - y) });
    } else box(bounds(el));
  }, true);
  document.addEventListener("pointerup", e => {
    if (!selecting || !down) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const anchor = candidate(down.element, down, { x: e.clientX, y: e.clientY });
    if (anchor) { cancel(); emit({ type: "selected", anchor, position: {x:e.clientX,y:e.clientY} }); }
    down = null;
  }, true);
  // Keep the synthetic click after pointerup from navigating the selected link.

  document.addEventListener("click", e => { if (selecting || suppressClick) { e.preventDefault(); e.stopImmediatePropagation(); suppressClick = false; } }, true);
  document.addEventListener("keydown", e => { if (selecting && e.key === "Escape") { e.preventDefault(); cancel(true); } }, true);
  const htmlLocations = new Map<string, Element | null>();
  const textLocations = new Map<string, Range | null>();
  function quoteRange(el:Element, quote:{exact:string;prefix?:string;suffix?:string}) {
    const { text, points } = textIndex(el);
    let at=text.indexOf(quote.exact);
    while(at>=0) {
      const end=at+quote.exact.length;
      if((!quote.prefix || text.slice(0,at).trimEnd().endsWith(quote.prefix)) && (!quote.suffix || text.slice(end).trimStart().startsWith(quote.suffix))) {
        const range=document.createRange(), first=points.slice(at,end).find(Boolean), last=points.slice(at,end).reverse().find(Boolean);
        if (!first || !last) return null;
        range.setStart(first.node,first.offset);range.setEnd(last.node,last.offset+1);return range;
      }
      at=text.indexOf(quote.exact,at+1);
    }
    return null;
  }
  function locate(anchor: CommentAnchor) {
    if (anchor.kind === "document") return { rect: null, outcome: "missing" as const };
    let el: Element | null = null;
    if (anchor.kind === "html" && anchor.filePath === filePath) {
      const key = JSON.stringify([anchor.selector, anchor.quote]);
      const cacheable = /^html(?:>[a-z][a-z0-9-]*:nth-of-type\([1-9]\d*\))+$/.test(anchor.selector);
      if (cacheable && htmlLocations.has(key)) el = htmlLocations.get(key)!;
      else {
        try { el = document.querySelector(anchor.selector); } catch { /* Invalid selectors are never executable. */ }
        // Content is verified once between DOM changes; scroll/resize only measure geometry.
        if (el && anchor.quote && !visibleText(el,100000).includes(anchor.quote.exact)) {
          const legacy = anchor.quote.prefix === undefined && anchor.quote.suffix === undefined;
          // Preserve the old concatenation semantics, not a whitespace-insensitive match.
          if (!legacy || !textIndex(el,100000,true).text.trim().includes(anchor.quote.exact)) el = null;
        }
        if (cacheable) htmlLocations.set(key, el);
        if (htmlLocations.size > 101) htmlLocations.delete(htmlLocations.keys().next().value!);
      }
      if (el && !layer.contains(el)) {
        if (anchor.quote && (anchor.quote.prefix !== undefined || anchor.quote.suffix !== undefined)) {
          if (!textLocations.has(key)) textLocations.set(key,quoteRange(el,anchor.quote));
          const range=textLocations.get(key);
          if (textLocations.size>101) textLocations.delete(textLocations.keys().next().value!);
          return {rect:range?.getBoundingClientRect() ?? null,outcome:range ? "exact" as const : "missing" as const};
        }
        return { rect: el.getBoundingClientRect(), outcome: "exact" as const };
      }
      return { rect: null, outcome: "missing" as const };
    }
    if (anchor.kind === "html") return { rect: null, outcome: "missing" as const };
    if (anchor.kind === "pdf") el = Array.from(document.querySelectorAll<HTMLElement>("canvas[data-comment-page]")).find(x => x.dataset.commentPage === String(anchor.page) && x.dataset.commentFile === anchor.filePath && x.getBoundingClientRect().width > 0) || null;
    if (anchor.kind === "image") el = Array.from(document.images).find(x => relativeImage(x) === anchor.filePath) || null;
    if (!el || !el.getBoundingClientRect().width) return { rect: null, outcome: "missing" as const };
    const b = bounds(el), r = anchor.region;
    const p = r.kind === "point" ? r.point : { x: r.rect.x, y: r.rect.y };
    const q = r.kind === "point" ? r.point : { x: r.rect.x + r.rect.width, y: r.rect.y + r.rect.height };
    const a = turn(p, (360 - rotation(el)) % 360), z = turn(q, (360 - rotation(el)) % 360);
    return { rect: { left: b.left + Math.min(a.x, z.x) * b.width, top: b.top + Math.min(a.y, z.y) * b.height, width: Math.abs(a.x - z.x) * b.width, height: Math.abs(a.y - z.y) * b.height }, outcome: "exact" as const };
  }

  function paint() {
    raf = 0; pins.replaceChildren();
    const elapsed = performance.now() - locatedAt;
    // Keep the persistent highlight's animation timeline stable across geometry paints.
    if (selecting || !focusedAnchor) highlight.style.animation="none";
    const active = visible ? markers : [];
    const list = temporary ? [...active.filter(x => x.threadId !== temporary!.threadId), temporary] : active;
    const menu = layer.querySelector<HTMLElement>("[data-comment-cluster]");
    if (menu && (!visible || !menu.dataset.group?.split(":").every(id => list.some(m => m.threadId === id)))) menu.remove();
    const used: { x: number; y: number; pin: HTMLElement; ids: string[] }[] = [];
    for (let i = 0; i < list.length; i++) {
      const r = locate(list[i].anchor).rect;
      if (!r || r.top < -40 || r.top > innerHeight || r.left > innerWidth || r.left < -40) continue;
      const nearby = used.find(p => Math.hypot(p.x - r.left, p.y - r.top) < 24);
      if (nearby) { nearby.ids.push(list[i].threadId); nearby.pin.textContent = String(nearby.ids.length); continue; }
      const pin = document.createElement("button"); pin.type = "button"; pin.textContent = "•"; const pinAnchor=list[i].anchor;pin.title=pinAnchor.kind === "html" ? pinAnchor.quote?.exact || pinAnchor.filePath : pinAnchor.filePath;
      pin.dataset.commentThread = list[i].threadId;
      const group = { x: r.left, y: r.top, pin, ids: [list[i].threadId] };
      pin.addEventListener("click", event => {
        event.preventDefault(); event.stopPropagation();
        if(group.ids.length===1){emit({type:"activated",threadId:group.ids[0]});return;}
        const existing=layer.querySelector<HTMLElement>("[data-comment-cluster]"); const groupKey=group.ids.join(":"); if(existing){const same=existing.dataset.group===groupKey;existing.remove();if(same)return;}
        const menu=document.createElement("div");menu.dataset.commentCluster="true";menu.dataset.group=groupKey;
        menu.style.cssText=`position:absolute;left:${Math.max(8,Math.min(innerWidth-240,r.left+30))}px;top:${Math.max(8,Math.min(innerHeight-180,r.top))}px;width:220px;max-height:170px;overflow:auto;padding:6px;background:white;color:#171a17;border:1px solid #e3e7e1;border-radius:8px;box-shadow:0 5px 20px #0002;pointer-events:auto`;
        group.ids.forEach((id,index)=>{
          const item=document.createElement("button"),marker=list.find(m=>m.threadId===id)!;
          const quote=marker.anchor.kind==="html"?marker.anchor.quote?.exact:null;
          item.textContent=`${index+1}. ${quote||marker.anchor.filePath}`;
          item.style.cssText="display:block;width:100%;padding:10px;border:0;background:white;color:#171a17;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer";
          item.onclick=e=>{e.preventDefault();e.stopPropagation();emit({type:"activated",threadId:id});menu.remove();};menu.append(item);
        });layer.append(menu);
        menu.querySelector("button")?.focus();
        menu.addEventListener("keydown", event => { if (event.key === "Escape") { event.stopPropagation(); menu.remove(); [...pins.querySelectorAll<HTMLButtonElement>("button")].find(item => item.dataset.commentThread === group.ids[0])?.focus(); } });

      });
      pin.style.cssText = `position:absolute;left:${Math.max(0, r.left)}px;top:${Math.max(0, r.top)}px;background:#557341;color:white;font:600 12px/26px system-ui;text-align:center;min-width:26px;height:26px;border-radius:50% 50% 50% 3px;border:2px solid white;box-shadow:0 1px 4px #0004;pointer-events:auto;cursor:pointer;padding:0`;
      if (!visible && temporary?.threadId === list[i].threadId && !matchMedia("(prefers-reduced-motion: reduce)").matches) pin.style.animation = `artifact-comment-locate ${flashMs}ms linear -${elapsed}ms both`;
      pins.append(pin); used.push(group);
    }
    if (menu?.isConnected) {
      const group = used.find(item => item.ids.join(":") === menu.dataset.group);
      if (!group || selecting) menu.remove();
      else { menu.style.left = `${Math.max(8, Math.min(innerWidth - 240, group.x + 30))}px`; menu.style.top = `${Math.max(8, Math.min(innerHeight - 180, group.y))}px`; }
    }
    if (selecting && hovered && !down) box(bounds(hovered));
    else if (!selecting && focusedAnchor) { const rect=locate(focusedAnchor).rect; if(rect)box(rect); }
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(paint); }
  addEventListener("scroll", schedule, true); addEventListener("resize", schedule);
  new MutationObserver(records => {
    const changes = records.filter(record => !layer.contains(record.target));
    if (changes.length) selectionCache = null;
    if (!changes.length) return;
    if (changes.some(record => record.type !== "attributes" || ["id", "class", "style", "contenteditable", "hidden", "aria-hidden"].includes(record.attributeName || ""))) { htmlLocations.clear(); textLocations.clear(); }
    schedule();
  }).observe(document.documentElement, { childList: true, characterData: true, subtree: true, attributes: true });
  addEventListener("message", (event: MessageEvent<PreviewCommentCommand>) => {
    if (event.source !== parent || (parentOrigin !== "*" && event.origin !== parentOrigin)) return;
    const msg = event.data;
    try { if (JSON.stringify(msg).length > 1024 * 1024) return; } catch { return; }
    if (!msg || msg.protocol !== "artifact-comments" || msg.schemaVersion !== 1 || typeof msg.channelId !== "string" || !/^[0-9a-f-]{36}$/i.test(msg.channelId) || !msg.scope || !msg.command) return;
    if (channelId && msg.channelId !== channelId) {
      // A host load event can rotate a provisional channel while late image resources finish.
      // Only a parent marker handshake may initialize a new channel; it clears all old state.
      if (msg.command.type !== "markers") return;
      cancel(); textSelectionEnabled=false; temporary = null; markers = []; visible = false; channelId = ""; scope = null;
    }
    if (channelId && JSON.stringify(msg.scope) !== JSON.stringify(scope)) return;
    if (!channelId) {
      if (msg.command.type !== "markers") return;
      channelId = msg.channelId; scope = msg.scope;
      if (document.readyState !== "loading") emit({ type: "ready", filePath });
    }
    mount();
    switch (msg.command.type) {
      case "text-selection": textSelectionEnabled = msg.command.enabled === true; textSelectionLabel = String(msg.command.label).slice(0,80); selectedText(); break;
      case "select": cancel(); selecting = true; temporary = null; document.documentElement.dataset.artifactCommentSelect = "true"; break;
      case "cancel": cancel(); temporary = null; layer.querySelector("[data-comment-cluster]")?.remove(); break;
      case "markers":
        if (!Array.isArray(msg.command.markers) || msg.command.markers.length > 100) return;
        if (visible && !msg.command.visible) { focusedAnchor=null; clearTimeout(focusTimer); if(!selecting)highlight.style.display="none"; temporary = null; layer.querySelector("[data-comment-cluster]")?.remove(); }
        markers = msg.command.markers; visible = !!msg.command.visible; break;
      case "locate": {
        temporary = { threadId: msg.command.threadId, anchor: msg.command.anchor };
        focusedAnchor = msg.command.anchor; locatedAt = performance.now(); clearTimeout(focusTimer);
        highlight.style.animation="none";
        void highlight.offsetWidth;
        if(!matchMedia("(prefers-reduced-motion: reduce)").matches) highlight.style.animation=`artifact-comment-locate ${flashMs}ms linear both`;
        focusTimer = setTimeout(() => { focusedAnchor=null; temporary=null; if(!selecting)highlight.style.display="none"; schedule(); }, flashMs);
        const result = locate(msg.command.anchor);
        if (result.rect) scrollBy({ top: result.rect.top - innerHeight / 3, left: 0, behavior: "instant" });
        emit({ type: "located", threadId: msg.command.threadId, outcome: result.outcome });
        break;
      }
    }
    schedule();
  });
}

export function commentPreviewBootstrap(filePath: string, parentOrigin: string, documentMode = false): string {
  const args = JSON.stringify([filePath, parentOrigin, documentMode, COMMENT_LOCATION_FLASH_MS]).replaceAll("<", "\\u003c");
  return `<script data-artifact-bootstrap>(${commentPreviewRuntime.toString()})(...${args},${canonicalPreviewPath.toString()});</script>`;
}
