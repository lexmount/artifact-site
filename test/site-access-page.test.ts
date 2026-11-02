import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, updateSiteVisibility, upsertUser } from "@/lib/db";
import { createSite, deleteSite } from "@/lib/sites";
import { mintSession } from "@/lib/session";
import * as sharing from "@/lib/share";
import * as sites from "@/lib/sites";
import NotFound from "@/app/not-found";
import { LocaleProvider } from "@/components/locale-provider";
import Page, { generateMetadata } from "@/app/s/[slug]/page";
import EditorPage from "@/app/s/[slug]/edit/page";

const context = vi.hoisted(() => ({ headers: new Headers({ host: "x" }) }));
vi.mock("next/headers", () => ({ headers: async () => context.headers, cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/components/recent-unavailable", () => ({ default: () => null }));
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "access-page-"));
  vi.stubEnv("ARTIFACT_DATA_DIR", dir);
  vi.stubEnv("ARTIFACT_DEFAULT_VISIBILITY", "public");
  vi.stubEnv("ARTIFACT_OIDC_ISSUER", "https://idp.example/oidc");
  vi.stubEnv("ARTIFACT_OIDC_CLIENT_ID", "client");
  vi.stubEnv("ARTIFACT_OIDC_CLIENT_SECRET", "secret");
  context.headers = new Headers({ host: "x" });
});
afterEach(async () => { await closeDbForTests(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const args = (slug: string, search: Record<string, string> = {}) => ({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(search) });
const publish = async () => (await createSite({ mode: "paste", html: "<title>Confidential title</title><body>Secret bytes</body>" }, { anonOwnerId: "owner-browser" })).site;

it("returns not-found for missing and deleted sites", async () => {
  await expect(Page(args("missing"))).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  const site = await publish(); await deleteSite(site.slug);
  await expect(Page(args(site.slug))).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
});
it("offers login for a private site without exposing its title or content", async () => {
  const site = await publish(); await updateSiteVisibility(site.id, "private");
  const html = renderToStaticMarkup(await Page(args(site.slug, { version: "missing" })));
  expect(html).toContain("Access denied");
  expect(html).toContain("Sign in and retry");
  expect(html).not.toContain("Confidential title"); expect(html).not.toContain("Secret bytes");
  expect((await generateMetadata(args(site.slug))).title).toBe("Access denied — artifact-site");
});
it("asks an authenticated stranger to obtain authorization and offers account switching", async () => {
  const site = await publish(); await updateSiteVisibility(site.id, "private");
  const user = await upsertUser({ authProvider: "oidc", providerSubject: "stranger", email: "reader@example.com", emailVerified: true });
  const session = await mintSession(new Request("https://x"), user.id);
  context.headers.set("cookie", session.cookie.split(";")[0]);
  const html = renderToStaticMarkup(await Page(args(site.slug)));
  expect(html).toContain("Your current account does not have access");
  expect(html).toContain("reader@example.com"); expect(html).toContain("Switch account"); expect(html).toContain("Retry access");
  expect(html).not.toContain("Sign in and retry");
});
it("lets guests view public sites and distinguishes missing versions", async () => {
  const site = await publish();
  expect((await Page(args(site.slug))).type).not.toBe("main");
  const html = renderToStaticMarkup(await Page(args(site.slug, { version: "missing" })));
  expect(html).toContain("Version not found");
  expect((await generateMetadata(args(site.slug, { version: "missing" }))).title).toBe("Version not found — artifact-site");
});
it("rechecks access after the owner grants it", async () => {
  const site = await publish(); await updateSiteVisibility(site.id, "private");
  expect(renderToStaticMarkup(await Page(args(site.slug)))).toContain("Access denied");
  await updateSiteVisibility(site.id, "public");
  expect((await generateMetadata(args(site.slug))).title).toContain("Confidential title");
  expect((await Page(args(site.slug))).type).not.toBe("main");
});
it("shows an edit permission screen instead of claiming the site is missing", async () => {
  const site = await publish(); await updateSiteVisibility(site.id, "private");
  expect(renderToStaticMarkup(await EditorPage(args(site.slug)))).toContain("Sign in and retry");
});
it("does not offer unavailable login when OIDC is disabled", async () => {
  vi.stubEnv("ARTIFACT_OIDC_ISSUER", "");
  const site = await publish(); await updateSiteVisibility(site.id, "private");
  const html = renderToStaticMarkup(await Page(args(site.slug)));
  expect(html).toContain("Access denied"); expect(html).not.toContain("Sign in and retry");
  expect(html).toContain("person who sent you the link");
});

it("does not claim a restricted version or an upstream failure is a missing site", async () => {
  const site = await publish();
  vi.spyOn(sharing, "canReadVersion").mockResolvedValue(false);
  expect(renderToStaticMarkup(await Page(args(site.slug)))).toContain("Access denied");
  expect((await generateMetadata(args(site.slug))).title).toBe("Access denied — artifact-site");
  vi.spyOn(sites, "getSiteView").mockRejectedValue(new Error("database unavailable"));
  await expect(Page(args(site.slug))).rejects.toThrow("database unavailable");
});
it("renders the agreed Chinese copy for missing and access-denied states", async () => {
  context.headers.set("accept-language", "zh-CN");
  expect(renderToStaticMarkup(await NotFound())).toContain("站点不存在");
  const site = await publish(); await updateSiteVisibility(site.id, "private");
  const html = renderToStaticMarkup(LocaleProvider({ locale: "zh-CN", children: await Page(args(site.slug)) }));
  expect(html).toContain("暂无访问权限"); expect(html).toContain("你尚未登录"); expect(html).toContain("登录后重试");
});
it("keeps removal separate from permission denial", async () => {
  const site = await publish();
  const view = (await sites.getSiteView(site.slug))!;
  vi.spyOn(sites, "getSiteView").mockResolvedValue({ ...view, site: { ...view.site, takenDownAt: Date.now() } });
  expect((await Page(args(site.slug))).props.children[0].props.children).toBe("This content has been removed");

});

it.each([100, 1000])("checks only the selected edit version with %i history entries", async count => {
  const site = await publish();
  context.headers.set("cookie", "__Host-ah_anon=owner-browser");
  const [current] = (await sites.listVersions(site.slug))!;
  const history = Array.from({ length: count }, (_, index) => ({ ...current, id: index ? `history-${index}` : current.id, current: index === 0 }));
  vi.spyOn(sites, "listVersions").mockResolvedValue(history);
  const check = vi.spyOn(sharing, "canReadVersion");
  const input = args(site.slug, { version: current.id });
  expect((await EditorPage(input)).props.versionId).toBe(current.id);
  expect(check).toHaveBeenCalledTimes(1);
  expect(check.mock.calls[0][2]).toBe(current.id);
  check.mockClear();
  const { generateMetadata: editMetadata } = await import("@/app/s/[slug]/edit/page");
  expect((await editMetadata(input)).title).toContain(site.title);
  expect(check).toHaveBeenCalledTimes(1);
});
it("resolves one version filter for a large picker without per-version authorization", async () => {
  const site = await publish();
  context.headers.set("cookie", "__Host-ah_anon=owner-browser");
  const [current] = (await sites.listVersions(site.slug))!;
  vi.spyOn(sites, "listVersions").mockResolvedValue(Array.from({ length: 1000 }, (_, index) => ({ ...current, id: index ? `history-${index}` : current.id, current: index === 0 })));
  const check = vi.spyOn(sharing, "canReadVersion");
  const filter = vi.spyOn(sharing, "readableVersionFilter");
  const page = await EditorPage(args(site.slug, { pick: "1" }));
  expect(page.props.versions).toHaveLength(1000);
  expect(filter).toHaveBeenCalledTimes(1);
  expect(check).not.toHaveBeenCalled();
});
