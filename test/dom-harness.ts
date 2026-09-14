// A minimal DOM, just enough to run the visual-editing bootstrap.
//
// The repo's vitest environment is node (no jsdom), and the bootstrap happens to be a plain string
// script: inject it into this fake DOM and we can assert on **real behaviour** — the port handshake,
// an artifact script grabbing the port, clone rejection, clearing patches by key — each of which
// reproduces its bug, instead of asserting that some string exists in the source.
//
// Only the DOM is fake; MessageChannel / MessagePort / MessageEvent / Event are node's real ones, so
// the bootstrap's "primitive snapshot + private port" code path genuinely executes.
//
// The DOM side also ships a MutationObserver (childList + subtree, callbacks on the microtask queue,
// takeRecords supported) — the whole "first sighting wins" rule is built on it, and without it not a
// line of that behaviour could be tested.
import { editorBootstrapScript } from "@/lib/editor-bootstrap";

type Listener = (event: FakeEvent) => void;

export interface FakeEvent {
  type?: string;
  target?: unknown;
  [key: string]: unknown;
  stopImmediatePropagation?: () => void;
  preventDefault?: () => void;
}

class FakeEventTarget {
  readonly listeners: Array<{ type: string; fn: Listener }> = [];

  addEventListener(type: string, fn: Listener): void {
    this.listeners.push({ type, fn });
  }

  removeEventListener(type: string, fn: Listener): void {
    const at = this.listeners.findIndex((l) => l.type === type && l.fn === fn);
    if (at >= 0) this.listeners.splice(at, 1);
  }

  /** Dispatches in registration order and **honours stopImmediatePropagation** — A1's defence
   *  relies on exactly that. */
  dispatch(type: string, event: FakeEvent): FakeEvent {
    let stopped = false;
    event.type = type;
    event.stopImmediatePropagation = () => { stopped = true; };
    if (typeof event.preventDefault !== "function") {
      event.preventDefault = () => { event.defaultPrevented = true; };
    }
    for (const l of [...this.listeners]) {
      if (l.type !== type) continue;
      l.fn(event);
      if (stopped) break;
    }
    return event;
  }
}

// —— MutationObserver ——
// Implements only what the bootstrap uses: childList + subtree, callbacks run as microtasks, takeRecords
// drains the queue synchronously. Observers are routed by "is the root an ancestor of this mutation",
// so fake documents from different mounts do not interfere with each other.

export interface FakeMutationRecord {
  type: "childList";
  target: FakeElement;
  addedNodes: FakeNode[];
  removedNodes: FakeNode[];
}

interface Watcher {
  root: FakeElement;
  queue: FakeMutationRecord[];
  cb: (records: FakeMutationRecord[]) => void;
  scheduled: boolean;
  live: boolean;
}

const watchers = new Set<Watcher>();

function isUnder(node: FakeNode, root: FakeElement): boolean {
  let cur: FakeNode | null = node;
  while (cur) {
    if (cur === (root as unknown as FakeNode)) return true;
    cur = cur.parentNode;
  }
  return false;
}

/** Records one childList mutation. target is the parent element that changed (as in browsers). */
function recordMutation(target: FakeElement, addedNodes: FakeNode[], removedNodes: FakeNode[]): void {
  if (!watchers.size) return;
  for (const w of watchers) {
    if (!w.live || !isUnder(target, w.root)) continue;
    w.queue.push({ type: "childList", target, addedNodes, removedNodes });
    if (w.scheduled) continue;
    w.scheduled = true;
    queueMicrotask(() => {
      w.scheduled = false;
      const batch = w.queue.splice(0);
      if (w.live && batch.length) w.cb(batch);
    });
  }
}

export class FakeMutationObserver {
  private entry: Watcher | null = null;

  constructor(private readonly cb: (records: FakeMutationRecord[]) => void) {}

  observe(root: FakeElement): void {
    if (this.entry) return;
    this.entry = { root, queue: [], cb: this.cb, scheduled: false, live: true };
    watchers.add(this.entry);
  }

  takeRecords(): FakeMutationRecord[] {
    return this.entry ? this.entry.queue.splice(0) : [];
  }

  disconnect(): void {
    if (!this.entry) return;
    this.entry.live = false;
    watchers.delete(this.entry);
    this.entry = null;
  }
}

export class FakeText {
  readonly nodeType = 3;
  parentNode: FakeElement | null = null;
  constructor(public nodeValue: string) {}
  get parentElement(): FakeElement | null { return this.parentNode; }
  get textContent(): string { return this.nodeValue; }
  get nextSibling(): FakeNode | null { return sibling(this); }
}

export type FakeNode = FakeElement | FakeText;

function sibling(node: FakeNode): FakeNode | null {
  const parent = node.parentNode;
  if (!parent) return null;
  const at = parent.childNodes.indexOf(node);
  return at >= 0 ? parent.childNodes[at + 1] ?? null : null;
}

export class FakeElement {
  readonly nodeType = 1;
  readonly attrs = new Map<string, string>();
  readonly childNodes: FakeNode[] = [];
  parentNode: FakeElement | null = null;
  contentEditable = "";
  focused = false;

  constructor(public readonly tagName: string) {}

  get parentElement(): FakeElement | null { return this.parentNode; }
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get nextSibling(): FakeNode | null { return sibling(this); }

  getAttribute(name: string): string | null { return this.attrs.has(name) ? this.attrs.get(name)! : null; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, String(value)); }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  removeAttribute(name: string): void { this.attrs.delete(name); }

  appendChild<T extends FakeNode>(node: T): T {
    detach(node);
    node.parentNode = this;
    this.childNodes.push(node);
    recordMutation(this, [node], []);
    return node;
  }

  replaceChild(next: FakeNode, old: FakeNode): FakeNode {
    const at = this.childNodes.indexOf(old);
    if (at < 0) throw new Error("replaceChild: node is not a child");
    detach(next);
    this.childNodes[at] = next;
    next.parentNode = this;
    old.parentNode = null;
    recordMutation(this, [next], [old]);
    return old;
  }

  removeChild(node: FakeNode): FakeNode {
    const at = this.childNodes.indexOf(node);
    if (at >= 0) {
      this.childNodes.splice(at, 1);
      node.parentNode = null;
      recordMutation(this, [], [node]);
    }
    return node;
  }

  contains(node: unknown): boolean {
    let cur = node as FakeNode | null;
    while (cur) { if (cur === (this as unknown as FakeNode)) return true; cur = cur.parentNode; }
    return false;
  }

  closest(): FakeElement | null { return null; } // only link interception needs it; unused in tests

  focus(): void { this.focused = true; }

  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }

  set textContent(value: string) {
    const gone = this.childNodes.splice(0);
    for (const c of gone) c.parentNode = null;
    if (gone.length) recordMutation(this, [], gone);
    this.appendChild(new FakeText(value));
  }

  /** Deep copy which, like the browser's cloneNode(true), **copies attributes too** — the clone
   *  carries the same marker number. */
  cloneNode(): FakeElement {
    const copy = new FakeElement(this.tagName);
    for (const [k, v] of this.attrs) copy.attrs.set(k, v);
    for (const c of this.childNodes) {
      copy.appendChild(c.nodeType === 3 ? new FakeText((c as FakeText).nodeValue) : (c as FakeElement).cloneNode());
    }
    return copy;
  }
}

function detach(node: FakeNode): void {
  node.parentNode?.removeChild(node);
}

const SELECTOR = /^\[([A-Za-z0-9-]+)(?:="([^"]*)")?\]$/;

export class FakeDocument extends FakeEventTarget {
  readyState = "complete";
  readonly documentElement = new FakeElement("html");
  readonly head = new FakeElement("head");
  readonly body = new FakeElement("body");

  constructor() {
    super();
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(tag: string): FakeElement { return new FakeElement(tag); }
  createTextNode(value: string): FakeText { return new FakeText(value); }

  querySelectorAll(selector: string): FakeElement[] {
    const parsed = SELECTOR.exec(selector);
    if (!parsed) throw new Error(`unsupported selector: ${selector}`);
    const [, name, value] = parsed;
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      if (el.hasAttribute(name) && (value === undefined || el.getAttribute(name) === value)) out.push(el);
      for (const c of el.childNodes) if (c.nodeType === 1) walk(c as FakeElement);
    };
    walk(this.documentElement);
    return out;
  }
}

export class FakeWindow extends FakeEventTarget {
  getSelection(): null { return null; } // the bootstrap falls back to pointText(e.target)
}

// —— Fake Event / MessageEvent ——
// At evaluation time the bootstrap **snapshots the getters** Event.prototype.isTrusted and
// MessageEvent.prototype.ports/source (artifact scripts run later, so rewriting the prototypes cannot
// fool it) and afterwards reads events only through those snapshots.
// Here we provide a pair of constructors that likewise expose those properties as prototype getters,
// handed to the bootstrap as Event / MessageEvent, so the snapshot code path really runs — rather
// than being bypassed via the "cannot read it, just take the property" fallback.
// node's own MessageEvent is unusable here: its constructor does not accept a window object as
// source, and **a constructed event's isTrusted is always false**, so it cannot express "a real
// event dispatched by the browser".
export class HarnessEvent {}
Object.defineProperty(HarnessEvent.prototype, "isTrusted", {
  configurable: true,
  get(this: Record<string, unknown>) { return this._isTrusted === true; },
});

export class HarnessMessageEvent extends HarnessEvent {}
for (const name of ["ports", "source"]) {
  Object.defineProperty(HarnessMessageEvent.prototype, name, {
    configurable: true,
    get(this: Record<string, unknown>) { return this[`_${name}`]; },
  });
}

/** Builds a message event "dispatched by the browser"; isTrusted / source / ports are readable
 *  only via the prototype getters. */
export function messageEvent(init: {
  isTrusted?: boolean;
  source?: unknown;
  data?: unknown;
  ports?: MessagePort[];
}): FakeEvent {
  const event = Object.create(HarnessMessageEvent.prototype) as Record<string, unknown>;
  event._isTrusted = init.isTrusted ?? true;
  event._source = init.source;
  event._ports = init.ports ?? [];
  event.data = init.data;
  return event as FakeEvent;
}

export interface Harness {
  doc: FakeDocument;
  win: FakeWindow;
  /** Pretends to be the iframe's `parent`. A legitimate handshake must carry it as event.source. */
  parent: object;
  /** The parent page's end of the channel (port1). */
  port: MessagePort;
  /** Messages received on the port, in arrival order. */
  inbox: Array<Record<string, unknown>>;
  /** Performs the parent-page → iframe handshake: transfers port2 of a fresh channel. */
  handshake(): void;
  /** Dispatches an event straight onto window (simulates a ping forged by an artifact script). */
  emit(event: FakeEvent): FakeEvent;
  /** Sends the iframe a message over the port. */
  send(message: Record<string, unknown>): void;
  dblclick(target: FakeElement): FakeEvent;
  /** window's load event — the bootstrap reports its stats right after it. */
  load(): void;
  close(): void;
}

/** Lets node's MessagePort deliver the messages it has queued. */
export function tick(times = 2): Promise<void> {
  return new Promise((resolve) => {
    let left = times;
    const step = () => (--left <= 0 ? resolve() : setImmediate(step));
    setImmediate(step);
  });
}

/** Work queued via setTimeout(...,0) (the bootstrap deliberately delays its stats one tick after load). */
export function macrotask(times = 2): Promise<void> {
  return new Promise((resolve) => {
    let left = times;
    const step = () => (--left <= 0 ? resolve() : setTimeout(step, 0));
    setTimeout(step, 0);
  });
}

/** Drains microtasks (MutationObserver) + macrotasks (the delayed stats) + port delivery in one go. */
export async function flush(): Promise<void> {
  await tick();
  await macrotask();
  await tick();
}

/**
 * Runs the bootstrap once inside the fake DOM. `build` sets up the page this test needs (it receives
 * document.body). `extraScript` simulates **the artifact's own script**: it runs after the bootstrap
 * (the real injection point is the very top of <head>, so artifact scripts always run later) and
 * receives the same window/document.
 */
export function mountBootstrap(options: {
  nonce?: string;
  /** With "loading" the bootstrap defers boot until DOMContentLoaded. */
  readyState?: string;
  build?: (body: FakeElement, doc: FakeDocument) => void;
  extraScript?: (win: FakeWindow, doc: FakeDocument) => void;
  /**
   * Hides MutationObserver from the bootstrap, to exercise the "very old browser" fallback path
   * (first-sighting registration degrades to "first in document order").
   */
  noMutationObserver?: boolean;
}): Harness {
  const nonce = options.nonce ?? "nonce_test";
  const doc = new FakeDocument();
  doc.readyState = options.readyState ?? "complete";
  const win = new FakeWindow();
  const parent = { name: "parent-window" };
  options.build?.(doc.body, doc);

  const source = editorBootstrapScript(nonce);
  const run = new Function("window", "document", "parent", "MessageEvent", "Event", "MessagePort", "MutationObserver", source);
  const before = new Set(watchers);
  run(win, doc, parent, HarnessMessageEvent, HarnessEvent, MessagePort, options.noMutationObserver ? undefined : FakeMutationObserver);
  // The bootstrap installs the observer at evaluation time; remember it and detach it in close() so
  // it does not outlive the test.
  const mine = [...watchers].filter((w) => !before.has(w));
  options.extraScript?.(win, doc);

  const inbox: Array<Record<string, unknown>> = [];
  let port: MessagePort | null = null;
  const channels: MessageChannel[] = [];

  const harness: Harness = {
    doc,
    win,
    parent,
    get port() { return port!; },
    inbox,
    handshake() {
      const channel = new MessageChannel();
      channels.push(channel);
      port = channel.port1;
      channel.port1.onmessage = (e: MessageEvent) => { inbox.push(e.data as Record<string, unknown>); };
      channel.port1.start();
      win.dispatch("message", messageEvent({
        source: parent,
        data: { type: "ah-editor:ping", nonce },
        ports: [channel.port2],
      }));
    },
    emit(event) { return win.dispatch("message", event); },
    send(message) { port!.postMessage({ nonce, ...message }); },
    dblclick(target) { return doc.dispatch("dblclick", { target, clientX: 1, clientY: 1 }); },
    load() { win.dispatch("load", {}); },
    close() {
      for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
      for (const w of mine) { w.live = false; watchers.delete(w); }
    },
  };
  return harness;
}

/** `<p data-ah-node="N" data-ah-texts="1">text</p>` — what a node looks like after server-side marking. */
export function marked(tag: string, el: number, texts: string[]): FakeElement {
  const node = new FakeElement(tag);
  node.setAttribute("data-ah-node", String(el));
  node.setAttribute("data-ah-texts", String(texts.length));
  for (const t of texts) node.appendChild(new FakeText(t));
  return node;
}
