import { afterEach, describe, expect, it, vi } from "vitest";
import { analyticsCampaign, analyticsPage, initializeAnalytics, setAnalyticsUser, track, trackPage, analyticsRequest, syncAnalyticsIdentity } from "@/lib/analytics";
import { config, __resetWarnedForTests } from "@/lib/config";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); __resetWarnedForTests(); });

function browser(href = "https://app.example.com/v/SECRET?token=PRIVATE#secret") {
  const w = { location: { href, hostname: "app.example.com" }, dataLayer: [] as unknown[], gtag: undefined };
  vi.stubGlobal("window", w);
  vi.stubGlobal("document", { referrer: "https://other.example.com/v/SECRET?token=PRIVATE" });
  return w;
}

describe("analytics privacy and delivery", () => {
  it("redacts dynamic paths, queries, fragments and unknown pages", () => {
    expect(analyticsPage("https://app.example.com/v/SECRET?token=PRIVATE#secret")).toEqual({
      page_location: "https://app.example.com/v/shared", page_title: "Shared artifact", page_type: "share",
    });
    expect(analyticsPage("https://app.example.com/s/private-title/edit?edit_token=SECRET").page_location).toBe("https://app.example.com/s/artifact/edit");
    expect(analyticsPage("https://app.example.com/secret-email@example.com").page_location).toBe("https://app.example.com/other");
  });
  it("is disabled by default and rejects malformed configuration", () => {
    vi.stubEnv("ARTIFACT_GA_MEASUREMENT_ID", "");
    expect(config.gaMeasurementId).toBe("");
    vi.stubEnv("ARTIFACT_GA_MEASUREMENT_ID", "bad<script>");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(config.gaMeasurementId).toBe("");
    expect(config.gaMeasurementId).toBe("");
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it("defaults to the existing public URL and permits an explicit host override", () => {
    vi.stubEnv("ARTIFACT_GA_HOSTS", "");
    vi.stubEnv("ARTIFACT_PUBLIC_URL", "https://APP.example.com:443/");
    expect(config.gaHosts).toEqual(["app.example.com"]);
    vi.stubEnv("ARTIFACT_GA_HOSTS", "a.example.com, b.example.com");
    expect(config.gaHosts).toEqual(["a.example.com", "b.example.com"]);
    vi.stubEnv("ARTIFACT_GA_HOSTS", "");
    vi.stubEnv("ARTIFACT_PUBLIC_URL", "");
    expect(config.gaHosts).toEqual([]);
    vi.stubEnv("ARTIFACT_PUBLIC_URL", "not-a-url");
    expect(config.gaHosts).toEqual([]);
  });
  it("does not collect on unlisted hosts", () => {
    const w = browser();
    expect(initializeAnalytics("G-TEST123", ["production.example.com"])).toBe(false);
    track("ui_click", { button_name: "upload" });
    expect(w.dataLayer).toHaveLength(0);
  });
  it("initializes once, sends sanitized pages once per navigation, and clears identity", () => {
    const w = browser();
    initializeAnalytics("G-TEST123", ["app.example.com"]);
    initializeAnalytics("G-TEST123", ["app.example.com"]);
    setAnalyticsUser("usr_123");
    trackPage(); trackPage();
    track("ui_click", { button_name: "upload", secret: "PRIVATE" } as never);
    w.location.href = "https://app.example.com/v/SECOND_SECRET";
    trackPage();
    setAnalyticsUser(null);
    const commands = w.dataLayer.map((x) => Array.from(x as ArrayLike<unknown>));
    expect(commands.filter((x) => x[0] === "js")).toHaveLength(1);
    expect(commands.filter((x) => x[1] === "page_view")).toHaveLength(2);
    expect(JSON.stringify(commands)).not.toMatch(/SECRET|PRIVATE|secret-email/);
    expect(commands.at(-1)).toEqual(["config", "G-TEST123", expect.objectContaining({ user_id: null, send_page_view: false })]);
  });
  it("never lets a broken tag interrupt the application", () => {
    const w = browser();
    initializeAnalytics("G-TEST123", ["app.example.com"]);
    Object.assign(w, { gtag: () => { throw new Error("blocked"); } });
    expect(() => track("ui_click", { button_name: "upload" })).not.toThrow();
  });
});


it("recognizes comments and OAuth without disclosing slugs or credentials", () => {
  expect(analyticsPage("https://app.example.com/s/SECRET/comments?share=SECRET")).toEqual({
    page_location: "https://app.example.com/s/artifact/comments", page_title: "Artifact comments", page_type: "comments",
  });
  expect(analyticsPage("https://app.example.com/oauth/authorize?client_id=SECRET").page_type).toBe("authorization");
});

it("retains the login hint until identity is available and consumes it once", () => {
  const w = browser();
  Object.assign(document, { cookie: "artifact_analytics_auth=new" });
  initializeAnalytics("G-TEST123", ["app.example.com"]);
  syncAnalyticsIdentity(null);
  expect(document.cookie).toBe("artifact_analytics_auth=new");
  syncAnalyticsIdentity("usr_123");
  syncAnalyticsIdentity("usr_123");
  const commands = w.dataLayer.map(x => Array.from(x as ArrayLike<unknown>));
  expect(commands.filter(x => x[1] === "sign_up")).toHaveLength(1);
  expect(commands.filter(x => x[0] === "config")).toHaveLength(2);
});

it("only counts HTTP or network request failures, not preflight or post-save exceptions", async () => {
  const w = browser();
  initializeAnalytics("G-TEST123", ["app.example.com"]);
  const failures = () => w.dataLayer.map(x => Array.from(x as ArrayLike<unknown>)).filter(x => x[1] === "artifact_operation_failed");
  await expect((async () => { throw new Error("No changes yet"); })()).rejects.toThrow();
  expect(failures()).toHaveLength(0);
  await expect((async () => {
    await analyticsRequest("update", () => Promise.resolve(new Response(null, { status: 200 })));
    track("artifact_update_success", { method: "visual" });
    throw new Error("UI writeback failed");
  })()).rejects.toThrow();
  expect(failures()).toHaveLength(0);
  expect((await analyticsRequest("update", () => Promise.resolve(new Response(null, { status: 409 })))).status).toBe(409);
  expect(failures()).toHaveLength(1);
  await expect(analyticsRequest("update", () => Promise.reject(new TypeError("Network failed")))).rejects.toThrow();
  expect(failures()).toHaveLength(2);
});

describe("campaign attribution", () => {
  const commands = (w: { dataLayer: unknown[] }) => w.dataLayer.map((x) => Array.from(x as ArrayLike<unknown>));
  const pageViews = (w: { dataLayer: unknown[] }) =>
    commands(w).filter((x) => x[1] === "page_view").map((x) => x[2] as Record<string, string>);
  function land(href: string) {
    const w = browser(href);
    initializeAnalytics("G-TEST123", ["app.example.com"]);
    trackPage();
    return w;
  }

  it("normalizes the three allowlisted tags into a fixed order", () => {
    expect(analyticsCampaign("https://app.example.com/?utm_campaign=Launch&utm_medium=social&utm_source=%20HN%20"))
      .toBe("utm_source=hn&utm_medium=social&utm_campaign=launch");
    expect(analyticsCampaign("https://app.example.com/?utm_source=a&utm_source=b")).toBe("utm_source=a");
    expect(analyticsCampaign("https://app.example.com/")).toBe("");
    expect(analyticsCampaign("not a url")).toBe("");
  });

  it("adds the tags to the landing page view", () => {
    const w = land("https://app.example.com/?utm_source=HN&utm_medium=social&utm_campaign=launch");
    expect(pageViews(w)).toEqual([expect.objectContaining({
      page_location: "https://app.example.com/?utm_source=hn&utm_medium=social&utm_campaign=launch",
      page_referrer: "https://other.example.com/",
    })]);
  });

  it("keeps the route label and drops every other query parameter", () => {
    const w = land("https://app.example.com/s/some-private-slug?utm_source=x&edit_token=SECRET"
      + "&utm_term=termmarker&utm_content=contentmarker&share=sharemarker&gclid=gclidmarker");
    expect(pageViews(w)[0].page_location).toBe("https://app.example.com/s/artifact?utm_source=x");
    expect(JSON.stringify(commands(w))).not.toMatch(/some-private-slug|SECRET|edit_token|marker|utm_term|utm_content|gclid/);
  });

  it("drops invalid values one by one and keeps the valid ones", () => {
    const long = land(`https://app.example.com/?utm_source=${"a".repeat(41)}&utm_medium=email&utm_campaign=spring%20sale`);
    expect(pageViews(long)[0].page_location).toBe("https://app.example.com/?utm_medium=email");
    const odd = land(`https://app.example.com/?utm_source=%3Cscript%3E&utm_medium=${encodeURIComponent("微信")}&utm_campaign=${"b".repeat(40)}`);
    expect(pageViews(odd)[0].page_location).toBe(`https://app.example.com/?utm_campaign=${"b".repeat(40)}`);
  });

  it("leaves the landing URL untouched when no tag survives", () => {
    const w = land("https://app.example.com/explore?utm_source=%3Cscript%3E&utm_medium=&utm_term=launch");
    expect(pageViews(w)[0].page_location).toBe("https://app.example.com/explore");
  });

  it("never lets later page views, events, referrers or the global page context carry the tags", () => {
    const w = land("https://app.example.com/?utm_source=hn&utm_medium=social&utm_campaign=launch");
    track("ui_click", { button_name: "upload" });
    w.location.href = "https://app.example.com/explore?utm_source=again";
    trackPage();
    track("share_link_copy", { share_type: "canonical" });
    const all = commands(w);
    const afterLanding = all.slice(all.findIndex((x) => x[1] === "page_view") + 1);
    expect(afterLanding.map((x) => (x[0] === "event" ? x[1] : x[0]))).toEqual(["ui_click", "set", "page_view", "share_link_copy"]);
    expect(JSON.stringify(afterLanding)).not.toMatch(/utm_|again/);
    expect(JSON.stringify(all.filter((x) => x[0] === "set"))).not.toMatch(/utm_/);
    expect(pageViews(w)[1]).toMatchObject({
      page_location: "https://app.example.com/explore", page_referrer: "https://app.example.com/",
    });
  });
});
