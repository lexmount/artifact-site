import { afterEach, expect, it, vi } from "vitest";
import Analytics from "@/components/analytics";

const mocked = vi.hoisted(() => ({ effects: [] as (() => unknown)[], auth: { user: null as { id: string } | null, loading: true } }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useEffect: (fn: () => unknown) => { mocked.effects.push(fn); } }));
vi.mock("next/navigation", () => ({ usePathname: () => new URL(window.location.href).pathname }));
vi.mock("@/lib/use-auth", () => ({ useAuth: () => mocked.auth }));
afterEach(() => { vi.unstubAllGlobals(); mocked.effects = []; mocked.auth = { user: null, loading: true }; });

it("sends the first page before auth resolves, retains failed-auth hints, and avoids route config repeats", () => {
  const scripts: unknown[] = [];
  const w = { location: { href: "https://app.example.com/", hostname: "app.example.com" }, dataLayer: [] as unknown[] };
  vi.stubGlobal("window", w);
  vi.stubGlobal("document", {
    referrer: "", cookie: "artifact_analytics_auth=new", getElementById: () => scripts[0],
    createElement: () => ({}), head: { appendChild: (script: unknown) => scripts.push(script) },
    addEventListener: () => {}, removeEventListener: () => {},
  });
  const renderEffects = () => {
    mocked.effects = [];
    Analytics({ measurementId: "G-TEST123", hosts: ["app.example.com"] });
    mocked.effects.forEach(effect => effect());
  };
  const commands = () => w.dataLayer.map(x => Array.from(x as ArrayLike<unknown>));
  renderEffects();
  expect(commands().filter(x => x[1] === "page_view")).toHaveLength(1);
  expect(scripts).toHaveLength(1);
  expect(document.cookie).toBe("artifact_analytics_auth=new");
  mocked.auth.loading = false;
  renderEffects();
  expect(document.cookie).toBe("artifact_analytics_auth=new");
  mocked.auth.user = { id: "usr_123" };
  renderEffects();
  expect(commands().filter(x => x[1] === "sign_up")).toHaveLength(1);
  w.location.href = "https://app.example.com/me";
  renderEffects();
  expect(commands().filter(x => x[1] === "page_view")).toHaveLength(2);
  expect(commands().filter(x => x[0] === "config")).toHaveLength(2);
});
