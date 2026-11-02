import { beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const state = vi.hoisted(() => ({ user: { id: "A" } as { id: string } | null, loading: false, error: false }));
vi.mock("@/lib/use-auth", () => ({ useAuth: () => ({ ...state, oidcEnabled: true }), loginHref: () => "/api/auth/login" }));
vi.mock("@/components/locale-provider", () => ({ useT: () => (text: string) => text }));
import AccountFormBoundary from "@/components/account-form-boundary";
beforeEach(() => { state.user = { id: "A" }; state.loading = false; state.error = false; });
it("remounts forms by confirmed identity and removes them while signed out", () => {
  const children = createElement("form", null, "Account-owned draft");
  expect(AccountFormBoundary({ children })?.key).toBe("A");
  state.user = null;
  expect(renderToStaticMarkup(createElement(AccountFormBoundary, null, children))).not.toContain("Account-owned draft");
  state.user = { id: "B" };
  expect(AccountFormBoundary({ children })?.key).toBe("B");
});
it("does not mount forms before the account check completes", () => {
  state.loading = true;
  expect(renderToStaticMarkup(createElement(AccountFormBoundary, null, createElement("form", null, "Private settings")))).not.toContain("Private settings");
});

it("blocks forms if account revalidation fails even with a cached identity", () => {
  state.error = true;
  const html = renderToStaticMarkup(createElement(AccountFormBoundary, null, createElement("form", null, "Private settings")));
  expect(html).not.toContain("Private settings");
  expect(html).toContain("Retry account check");
});
