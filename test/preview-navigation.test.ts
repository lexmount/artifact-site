import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { previewNavigationBootstrap } from "@/lib/preview-navigation";

class Link {
  tagName = "A";
  addEventListener() {}
  removeEventListener() {}
  constructor(readonly attributes: Record<string, string>) {}
  get href() { return this.attributes.href; }
  hasAttribute(name: string) { return name in this.attributes; }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
}

function harness(baseTarget: string | null = null, mount?: string) {
  const messages: Array<{ type: string; path?: string }> = [];
  let receive: (event: unknown) => void = () => {};
  let capture: (event: unknown) => void = () => {};
  const tasks: Array<() => void> = [];
  const historyListeners = new Map<string, () => void>();
  const bubbles = new Set<(event: unknown) => void>();
  const window = { addEventListener(type: string, handler: typeof capture, capturePhase: boolean) {
    if (type === "message") receive = handler;
    else if (type === "click" && capturePhase) capture = handler;
    else if (type === "click") bubbles.add(handler);
    else if (type === "popstate" || type === "hashchange") historyListeners.set(type, () => handler({}));
  }, removeEventListener(_type: string, handler: typeof capture) { bubbles.delete(handler); } };
  const parent = mount === undefined ? window : { postMessage: (message: { type: string; path?: string }) => messages.push(message) };
  runInNewContext(previewNavigationBootstrap(mount ?? "").replace(/^<script[^>]*>|<\/script>$/g, ""), {
    window, parent, URL, Element: Link, HTMLAnchorElement: Link,
    location: { href: "https://hub.example/api/preview/site/nested.html?v=old#previous" },
    document: {
      baseURI: "https://hub.example/api/preview/site~credential/",
      querySelector: () => baseTarget === null ? null : new Link({ target: baseTarget }),
    },
    setTimeout: (task: () => void) => { tasks.push(task); },
  });
  receive({ source: parent, origin: "https://hub.example", data: { type: "artifact:platform-navigation-enabled" } });
  return {
    messages,
    capture: (event: ReturnType<typeof activation>) => {
      const path = [...event.composedPath(), window];
      const dispatched = { ...event, composedPath: () => path, currentTarget: window };
      capture(dispatched);
      [...bubbles].forEach(listener => listener(dispatched));
    },
    flush: () => tasks.splice(0).forEach(task => task()),
    history: (type: string) => historyListeners.get(type)?.(),
  };
}

function activation(link: Link, extra = {}) {
  return { button: 0, composedPath: () => [link], ...extra };
}

describe("fragment URL correction", () => {
  it.each(["popstate", "hashchange"])("restores once before %s handlers and keeps timer cleanup harmless", type => {
    const h = harness(), link = new Link({ href: "#target" });
    h.capture(activation(link));
    const absolute = link.href;
    h.history(type);
    expect(link.href).toBe("#target");
    link.setAttribute("href", absolute);
    h.history(type); h.flush();
    expect(link.href).toBe(absolute);
  });
  it("uses the loaded document and restores the exact source attribute", () => {
    const h = harness(), link = new Link({ href: "  #安装  " });
    h.capture(activation(link));
    expect(link.href).toBe("https://hub.example/api/preview/site/nested.html?v=old#%E5%AE%89%E8%A3%85");
    h.flush();
    expect(link.href).toBe("  #安装  ");
  });
  it("does not overwrite an artifact handler's intentional href change", () => {
    const h = harness(), link = new Link({ href: "#old" });
    h.capture(activation(link));
    link.setAttribute("href", "#new"); h.flush();
    expect(link.href).toBe("#new");
  });
  it.each([
    [{ href: "other.html#x" }, {}], [{ href: "#x", download: "" }, {}],
    [{ href: "#x", target: "_blank" }, {}], [{ href: "#x" }, { ctrlKey: true }],
    [{ href: "#x" }, { metaKey: true }], [{ href: "#x" }, { shiftKey: true }],
    [{ href: "#x" }, { altKey: true }], [{ href: "#x" }, { button: 1 }],
    [{ href: "#x" }, { defaultPrevented: true }],
  ])("preserves special link semantics: %j %j", (attributes, extra) => {
    const h = harness(), link = new Link(attributes as Record<string, string>);
    const before = link.href;
    h.capture(activation(link, extra));
    expect(link.href).toBe(before);
  });
  it("honors inherited target and an explicit _self override", () => {
    const h = harness("_blank"), link = new Link({ href: "#x" });
    h.capture(activation(link)); expect(link.href).toBe("#x");
    link.setAttribute("target", "_self"); h.capture(activation(link));
    expect(link.href).toContain("nested.html?v=old#x");
  });
});


describe("mounted platform navigation", () => {
  it.each([
    ["/artifact-site", "/"], ["/artifact-site/", "/"], ["/artifact-site/me", "/me"],
    ["https://hub.example/artifact-site/explore?ignored=yes", "/explore"],
    ["/me", null], ["/artifact-site/api/sites", null], ["/artifact-site/me/other", null],
    ["/artifact-site-other/me", null], ["https://evil.example/artifact-site/me", null],
    ["https://user:pass@hub.example/artifact-site/me", null],
  ])("maps only a fixed destination in the current mount: %s", (href, expected) => {
    const h = harness(null, "/artifact-site");
    let prevented = false;
    h.capture(activation(new Link({ href }), { preventDefault: () => { prevented = true; } }));
    const navigation = h.messages.filter(message => message.type === "artifact:platform-navigation");
    expect(prevented).toBe(expected !== null);
    expect(navigation.map(message => message.path)).toEqual(expected === null ? [] : [expected]);
  });
});
