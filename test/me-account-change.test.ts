import { beforeEach, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DirectoryPage } from "@/lib/directory-query";

const state = vi.hoisted(() => ({ userId: "A" as string | null, error: false, refresh: vi.fn(), effects: [] as (() => void)[] }));
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(), useEffect: (effect: () => void) => { state.effects.push(effect); } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: state.refresh, push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/use-auth", () => ({ useAuth: () => ({ loading: false, error: state.error, user: state.userId ? { id: state.userId } : null, oidcEnabled: true }), loginHref: () => "/api/auth/login" }));
vi.mock("@/components/locale-provider", () => ({ useT: () => (text: string) => text }));
vi.mock("@/components/app-shell", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/my-sites", () => ({ default: ({ sites, userId }: { sites: { title: string }[]; userId?: string }) => createElement("div", { "data-owner": userId }, sites.map(s => s.title).join(",")) }));
vi.mock("@/components/recent-sites", () => ({ useRecentShelf: () => ({ items: [] }) }));
vi.mock("@/lib/my-sites", () => ({ NO_SLUGS: [], useOwnerSlugs: () => [], mergeMySites: () => [] }));
vi.mock("@/components/admin/format", () => ({ adminFetch: vi.fn().mockResolvedValue({ tenants: [], sites: [] }) }));
import MePage from "@/components/me-page";

beforeEach(() => { state.userId = "A"; state.error = false; state.effects = []; state.refresh.mockClear(); });
const directory = (title: string) => ({ query: { scope: "owned" }, counts: { all: 1 }, sites: [{ title }] }) as DirectoryPage;
const render = (userId: string | undefined, title = "Private A") => renderToStaticMarkup(createElement(MePage, { userId, allSites: [], directory: userId ? directory(title) : undefined }));

it("hides stale server data across A, guest and B until B's payload arrives", () => {
  expect(render("A")).toContain("Private A");
  state.userId = null;
  expect(render("A")).not.toContain("Private A");
  state.userId = "B";
  state.effects = [];
  const stale = render("A");
  expect(stale).not.toContain("Private A");
  expect(stale).not.toContain('data-owner="A"');
  state.effects.forEach(effect => effect());
  expect(state.refresh).toHaveBeenCalled();
  const fresh = render("B", "Private B");
  expect(fresh).toContain("Private B");
  expect(fresh).toContain('data-owner="B"');
});

it("refreshes an anonymous server payload after signing in", () => {
  state.userId = "B";
  expect(render(undefined)).not.toContain("Private A");
  state.effects.forEach(effect => effect());
  expect(state.refresh).toHaveBeenCalled();
});

it.each([null, "B"])("does not refresh the route when account verification fails with identity %s", userId => {
  state.userId = userId;
  state.error = true;
  const failed = render("A");
  expect(failed).not.toContain("Private A");
  state.effects.forEach(effect => effect());
  expect(state.refresh).not.toHaveBeenCalled();
  expect(failed).toContain("Retry account check");
  expect(failed).not.toContain('class="spin"');
});

it("keeps a matching account visible after a failed revalidation", () => {
  state.error = true;
  expect(render("A")).toContain("Private A");
});
