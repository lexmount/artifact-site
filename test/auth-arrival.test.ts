import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { shouldAnimateAuthArrival } from "@/components/auth-button";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
const auth = read("src/components/auth-button.tsx");
const hook = read("src/lib/use-auth.ts");
const css = read("src/app/globals.css");

describe("auth state arrival", () => {
  it("reserves header space while the account request is unresolved", () => {
    expect(auth).toContain('className="auth-slot is-loading"');
    expect(auth).toContain('className="auth-placeholder"');
    expect(css).toMatch(/\.site-header \.auth-slot\s*\{[^}]*min-width:\s*92px/);
  });

  it("only animates on the home page for signed-out or genuinely changed identity states", () => {
    expect(auth).toContain('if (path !== "/") return false');
    expect(shouldAnimateAuthArrival("/", "signed-out", null)).toBe(false);
    expect(shouldAnimateAuthArrival("/", "signed-out", "signed-out")).toBe(false);
    expect(shouldAnimateAuthArrival("/", "signed-out", "user:1")).toBe(true);
    expect(shouldAnimateAuthArrival("/", "user:1", null)).toBe(true);
    expect(shouldAnimateAuthArrival("/", "user:1", "user:1")).toBe(false);
    expect(shouldAnimateAuthArrival("/", "user:1", "signed-out")).toBe(true);
    expect(shouldAnimateAuthArrival("/me", "signed-out", "user:1")).toBe(false);
    expect(auth).toContain('path === "/" && configured && !hasSessionHint && variant === "avatar"');
    expect(auth).toContain('t("Sign in / Sign up")');
    expect(auth).toContain("window.sessionStorage.setItem(AUTH_ARRIVAL_STATE_KEY, current)");
    expect(auth).toContain("useState(false)");
    expect(auth).toContain("const [animate] = useState(() => {");
    expect(auth).toContain('return children(animate && path === "/")');
    expect(auth).not.toContain("requestAnimationFrame");
    expect(auth).not.toContain("is-arrival-pending");
    expect(auth).toContain('animateArrival ? " auth-arrival" : ""');
    expect(css).toContain(".auth-slot.should-animate::before");
    expect(hook).toContain("useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot)");
    expect(hook).toContain("function getServerSnapshot(): AuthState { return loadingSnapshot; }");
    expect(hook).toMatch(/resetAuthCache[\s\S]*void load\(\)/);
  });

  it("uses a short brake/squash motion with a reduced-motion fallback", () => {
    expect(css).toContain("@keyframes auth-brake-in");
    expect(css).toContain("scaleX(1.08) scaleY(.92)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation: auth-fade-in .12s linear both !important");
  });
});
