// Browser-only, opt-in analytics. All fields crossing the boundary are allowlisted.
type Events = {
  ui_click: { button_name: "upload" | "login" | "share" | "download" | "update" };
  login: { method: "oidc" };
  sign_up: { method: "oidc" };
  artifact_publish_success: { upload_method: "inline" | "chunked" };
  artifact_update_success: { method: "source" | "visual" | "document" };
  artifact_operation_failed: { operation: "publish" | "update"; error_code: "operation_failed" };
  share_link_copy: { share_type: "canonical" | "share_link" };
};
type State = { loaded?: boolean; id: string; lastPath?: string; referrer: string; userId: string | null; campaign?: string };
declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    artifactAnalytics?: State;
  }
}

export function analyticsPage(href: string) {
  const url = new URL(href);
  const path = url.pathname;
  let route = "/other", title = "Other", type = "other";
  const pages: Record<string, [string, string]> = {
    "/": ["Home", "home"], "/explore": ["Explore", "explore"], "/me": ["My artifacts", "account"],
    "/tenants": ["Workspaces", "workspaces"], "/activate": ["Device activation", "activation"],
    "/oauth/authorize": ["Authorize application", "authorization"],
    "/for-agents": ["Agent guide", "guide"], "/publish-from-page": ["Publish from page", "publish"],
  };
  if (pages[path]) { route = path; [title, type] = pages[path]; }
  else if (/^\/v\/[^/]+\/?$/.test(path)) { route = "/v/shared"; title = "Shared artifact"; type = "share"; }
  else if (/^\/s\/[^/]+\/comments\/?$/.test(path)) { route = "/s/artifact/comments"; title = "Artifact comments"; type = "comments"; }
  else if (/^\/s\/[^/]+\/edit\/?$/.test(path)) { route = "/s/artifact/edit"; title = "Edit artifact"; type = "editor"; }
  else if (/^\/s\/[^/]+\/?$/.test(path)) { route = "/s/artifact"; title = "Artifact"; type = "viewer"; }
  else if (path === "/admin" || path.startsWith("/admin/")) { route = "/admin"; title = "Administration"; type = "admin"; }
  return { page_location: url.origin + route, page_title: title, page_type: type };
}

const campaignKeys = ["utm_source", "utm_medium", "utm_campaign"] as const;
/** Allowlisted campaign tags from a landing URL, normalized and in a fixed order; "" if none survive. */
export function analyticsCampaign(href: string): string {
  let params: URLSearchParams;
  try { params = new URL(href).searchParams; } catch { return ""; }
  return campaignKeys.flatMap((key) => {
    const value = params.get(key)?.trim().toLowerCase() ?? "";
    return /^[a-z0-9._-]{1,40}$/.test(value) ? [`${key}=${value}`] : [];
  }).join("&");
}

function send(...args: unknown[]) {
  try {
    // Bound the pre-load queue if the external script is blocked.
    if (window.artifactAnalytics && (window.artifactAnalytics.loaded || (window.dataLayer?.length ?? 0) < 200)) window.gtag?.(...args);
  } catch { /* Analytics must never break a product action. */ }
}

export function initializeAnalytics(id: string, hosts: string[]): boolean {
  if (typeof window === "undefined" || !/^G-[A-Z0-9]+$/.test(id) || !hosts.includes(window.location.hostname)) return false;
  if (window.artifactAnalytics) return window.artifactAnalytics.id === id;
  let referrer = "";
  try { referrer = new URL(document.referrer).origin + "/"; } catch { /* Direct visit. */ }
  // Read once per page load; trackPage attaches the tags to the landing page_view only.
  window.artifactAnalytics = { id, referrer, userId: null, campaign: analyticsCampaign(window.location.href) };
  window.dataLayer ??= [];
  // Google's command queue uses the Arguments shape.
  // eslint-disable-next-line prefer-rest-params
  window.gtag ??= function () { window.dataLayer!.push(arguments); };
  send("js", new Date());
  send("set", { ...analyticsPage(window.location.href), page_referrer: referrer });
  send("config", id, {
    send_page_view: false, user_id: null,
    allow_google_signals: false, allow_ad_personalization_signals: false,
  });
  return true;
}

export function setAnalyticsUser(userId: string | null) {
  if (typeof window === "undefined" || !window.artifactAnalytics) return;
  if (window.artifactAnalytics.userId === userId) return;
  window.artifactAnalytics.userId = userId;
  send("config", window.artifactAnalytics.id, { user_id: userId, send_page_view: false });
}

export function trackPage() {
  if (typeof window === "undefined" || !window.artifactAnalytics) return;
  const state = window.artifactAnalytics;
  const path = new URL(window.location.href).pathname;
  // Compare real paths locally so visits to two artifacts count separately. Never send them.
  if (state.lastPath === path) return;
  const page = analyticsPage(window.location.href);
  // GA4 attributes the session from the landing hit, so campaign tags go on that page_view alone.
  // The global page context and later referrers stay route-only, or every later event inherits them.
  const landing = state.campaign ? { ...page, page_location: `${page.page_location}?${state.campaign}` } : page;
  state.campaign = undefined;
  send("set", { ...page, page_referrer: state.referrer });
  send("event", "page_view", { ...landing, page_referrer: state.referrer });
  state.lastPath = path;
  state.referrer = page.page_location;
}

const allowed: Record<string, Record<string, readonly string[]>> = {
  ui_click: { button_name: ["upload", "login", "share", "download", "update"] },
  login: { method: ["oidc"] }, sign_up: { method: ["oidc"] },
  artifact_publish_success: { upload_method: ["inline", "chunked"] },
  artifact_update_success: { method: ["source", "visual", "document"] },
  artifact_operation_failed: { operation: ["publish", "update"], error_code: ["operation_failed"] },
  share_link_copy: { share_type: ["canonical", "share_link"] },
};
export function track<E extends keyof Events>(event: E, params: Events[E]) {
  if (typeof window === "undefined" || !window.artifactAnalytics || !allowed[event]) return;
  try {
    const safe: Record<string, string> = {};
    for (const [key, values] of Object.entries(allowed[event])) {
      const value = (params as Record<string, string>)[key];
      if (values.includes(value)) safe[key] = value;
    }
    send("event", event, { ...analyticsPage(window.location.href), page_referrer: window.artifactAnalytics.referrer, ...safe });
  } catch { /* Optional telemetry. */ }
}


/** Retain the callback hint across failed/pending auth reads; consume after identification. */
export function syncAnalyticsIdentity(userId: string | null) {
  if (typeof window === "undefined" || !window.artifactAnalytics) return;
  setAnalyticsUser(userId);
  if (!userId) return;
  // Untrusted telemetry only: clients can recreate the cookie or emit GA events directly.
  const outcome = document.cookie.split("; ").find(c => c.startsWith("artifact_analytics_auth="))?.split("=")[1];
  if (outcome !== "new" && outcome !== "login") return;
  track("login", { method: "oidc" });
  if (outcome === "new") track("sign_up", { method: "oidc" });
  document.cookie = "artifact_analytics_auth=; Path=/; Max-Age=0; SameSite=Lax";
}

/** Scope failure telemetry to the actual request, excluding preflight and UI writeback. */
export async function analyticsRequest(operation: "publish" | "update", request: () => Promise<Response>): Promise<Response> {
  let response: Response;
  try { response = await request(); }
  catch (error) {
    track("artifact_operation_failed", { operation, error_code: "operation_failed" });
    throw error;
  }
  if (!response.ok) track("artifact_operation_failed", { operation, error_code: "operation_failed" });
  return response;
}
