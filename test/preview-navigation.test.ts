import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { platformDestination, previewNavigationBootstrap } from "@/lib/preview-navigation";
import { shareDiscussionUrl } from "@/components/share-model";

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
  const messages: Array<{ type: string; path?: string; newTab?: boolean }> = [];
  let receive: (event: unknown) => void = () => {};
  type Handler = (event: unknown) => void;
  const captures = new Map<string, Set<Handler>>(), bubbles = new Map<string, Set<Handler>>();
  const tasks: Array<() => void> = [];
  const historyListeners = new Map<string, () => void>();
  const window = { addEventListener(type: string, handler: Handler, capturePhase: boolean) {
    if (type === "message") receive = handler;
    else if (type === "click" || type === "auxclick") {
      const listeners = capturePhase ? captures : bubbles;
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    }
    else if (type === "popstate" || type === "hashchange") historyListeners.set(type, () => handler({}));
  }, removeEventListener(type: string, handler: Handler, capturePhase: boolean) { (capturePhase ? captures : bubbles).get(type)?.delete(handler); } };
  const parent = mount === undefined ? window : { postMessage: (message: { type: string; path?: string }) => messages.push(message) };
  runInNewContext(previewNavigationBootstrap(mount ?? "").replace(/^<script[^>]*>|<\/script>$/g, ""), {
    window, parent, URL, URLSearchParams, Element: Link, HTMLAnchorElement: Link,
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
      [...captures.get(event.type) ?? []].forEach(listener => listener(dispatched));
      [...bubbles.get(event.type) ?? []].forEach(listener => listener(dispatched));
    },
    flush: () => tasks.splice(0).forEach(task => task()),
    history: (type: string) => historyListeners.get(type)?.(),
  };
}

function activation(link: Link, extra = {}) {
  return { type: "click", button: 0, composedPath: () => [link], ...extra };
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

describe("platform viewer destinations", () => {
  it.each([
    ["/c/collection_123", "/c/collection_123"],
    ["/c/collection_123?folder=folder_1&q=hello%20world&return_to=https://evil.example", "/c/collection_123?folder=folder_1&q=hello+world"],
    ["/s/site-123?version=ver_1&collection=collection_123&presentation=1", "/s/site-123?version=ver_1&collection=collection_123&presentation=1"],
    ["/v/share_123?version=ver_2&presentation=1", "/v/share_123?version=ver_2&presentation=1"],
    ["/s/site?version=ver_1#comment=thread_1", "/s/site?version=ver_1#comment=thread_1"],
    ["/v/share?thread=thread_1&message=msg_1&comments=all", "/v/share?thread=thread_1&message=msg_1&comments=all"],
    ["/s/site?thread=thread_1&message=msg_1&comments=all#comment=thread_2&ignored=1", "/s/site?thread=thread_1&message=msg_1&comments=all#comment=thread_2"],
    ["/c/collection_123?thread=thread_1&message=msg_1&comments=all#comment=thread_1", "/c/collection_123"],
    ["/s/site?thread=..%2Fsecret&message=msg%0A1&comments=unexpected#comment=%2Fapi%2Fauth%2Flogout", "/s/site"],
    ["/v/share?thread=&message=&comments=all#comment=", "/v/share?comments=all"],
    [`/s/site?thread=${"x".repeat(129)}&message=${"x".repeat(129)}#comment=${"x".repeat(129)}`, "/s/site"],
    ["/s/site?published=1&version=../secret&presentation=2#ignored", "/s/site"],
    ["/", "/"], ["/me?return_to=/api/auth/logout", "/me"],
  ])("keeps only read-only destinations and view parameters: %s", (input, expected) => {
    expect(platformDestination(input)).toBe(expected);
  });
  it.each([null, {}, "/api/auth/logout", "/oauth/authorize", "/s/site/edit", "/c/", "/c/../me",
    "/c/%2e%2e", "/c/site%2fedit", "//evil.example/c/site", "https://hub.example/c/site", "/c/site\\evil", "/c/site\n",
  ])("rejects unsafe destinations: %j", input => { expect(platformDestination(input)).toBeNull(); });
  it.each([
    [{ target: "_blank" }, {}, true], [{}, { ctrlKey: true }, true], [{}, { metaKey: true }, true],
    [{}, { shiftKey: true }, true], [{}, { type: "auxclick", button: 1 }, true],
    [{ target: "_self" }, {}, false], [{ target: "_top" }, {}, false],
  ])("hands viewer link activation to the host: %j %j", (attrs, extra, newTab) => {
    const h = harness(null, "/artifact-site");
    let prevented = false;
    h.capture(activation(new Link({ href: "/artifact-site/c/collection_123", ...attrs }), { ...extra, preventDefault: () => { prevented = true; } }));
    expect(prevented).toBe(true);
    expect(h.messages.filter(message => message.type === "artifact:platform-navigation"))
      .toEqual([{ type: "artifact:platform-navigation", path: "/c/collection_123", newTab }]);
  });
  it("honors base target for platform links", () => {
    const h = harness("_blank", "");
    h.capture(activation(new Link({ href: "/c/collection_123" }), { preventDefault() {} }));
    expect(h.messages.at(-1)).toEqual({ type: "artifact:platform-navigation", path: "/c/collection_123", newTab: true });
  });
  it.each(["", "/artifact-site"])("preserves comment destinations through the bootstrap and host validator at %s", mount => {
    for (const path of ["/s/site?version=ver_1#comment=thread_1", "/v/share?thread=thread_1&message=msg_1&comments=all"]) {
      const h = harness(null, mount);
      h.capture(activation(new Link({ href: mount + path }), { preventDefault() {} }));
      const message = h.messages.at(-1)!;
      expect(message.path).toBe(path);
      expect(platformDestination(message.path)).toBe(path);
    }
  });
  it.each(["", "/artifact-site"])("preserves platform-generated discussion links through both validators at %s", mount => {
    for (const route of ["/v/share_1", "/s/report_1?version=ver_1#comment=thread_1"]) {
      const url = new URL(shareDiscussionUrl(`https://hub.example${mount}${route}`));
      const expected = url.pathname.slice(mount.length) + url.search + url.hash;
      const h = harness(null, mount);
      h.capture(activation(new Link({ href: url.href }), { preventDefault() {} }));
      expect(h.messages.at(-1)?.path).toBe(expected);
      expect(platformDestination(expected)).toBe(expected);
    }
  });
  it.each([
    [{ download: "" }, {}], [{}, { altKey: true }], [{}, { defaultPrevented: true }],
    [{}, { type: "auxclick", button: 2 }],
    [{ href: "https://evil.example/c/collection_123" }, {}],
    [{ href: "/artifact-site/api/auth/logout" }, {}],
  ])("does not turn unrelated or cancelled actions into host navigation: %j %j", (attrs, extra) => {
    const h = harness(null, "/artifact-site");
    let prevented = false;
    h.capture(activation(new Link({ href: "/artifact-site/c/collection_123", ...attrs }), { ...extra, preventDefault: () => { prevented = true; } }));
    expect(prevented).toBe(false);
    expect(h.messages.filter(message => message.type === "artifact:platform-navigation")).toEqual([]);
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
