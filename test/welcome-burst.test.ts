import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[], set: vi.fn(), refresh: vi.fn(), notify: vi.fn(), reset: vi.fn() }));
vi.mock("react", () => ({ useRef: () => ({ current: undefined }), useEffect: (fn: () => void) => mocks.effects.push(fn), useState: (value: unknown) => [value, mocks.set] }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/locale-provider", () => ({ useT: () => (key: string) => key }));
vi.mock("@/lib/use-auth", () => ({ useAuth: () => ({ user: null, error: false }) }));
vi.mock("@/lib/auth-store", () => ({ refreshAuth: mocks.refresh, resetAuthCache: mocks.reset, notifyAuthChange: mocks.notify }));
import WelcomeBurst from "@/components/welcome-burst";
beforeEach(() => {
  vi.useFakeTimers(); mocks.effects.length = 0; vi.clearAllMocks();
  vi.stubGlobal("window", { location: { href: "https://app.example.com/?welcome=0" }, history: { replaceState: vi.fn() }, matchMedia: () => ({ matches: false }), setTimeout });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it.each([{ user: null, error: false }, { user: { id: "u1" }, error: true }])("never celebrates an unconfirmed session: %j", async (auth) => {
  mocks.refresh.mockResolvedValue(auth);
  WelcomeBurst(); mocks.effects[0](); await Promise.resolve();
  expect(mocks.set).not.toHaveBeenCalled();
  expect(window.history.replaceState).toHaveBeenCalledWith(null, "", "/");
});
it("waits for the real session before celebrating", async () => {
  let resolve!: (value: unknown) => void;
  mocks.refresh.mockReturnValue(new Promise((done) => { resolve = done; }));
  WelcomeBurst(); mocks.effects[0]();
  expect(mocks.set).not.toHaveBeenCalled();
  resolve({ user: { id: "u1" }, error: false }); await Promise.resolve();
  expect(mocks.set).toHaveBeenCalledWith(0);
  expect(mocks.set).toHaveBeenCalledTimes(2);
  expect(mocks.notify).not.toHaveBeenCalled();
  expect(mocks.reset).not.toHaveBeenCalled();
});

it("survives effect cleanup/replay without celebrating twice", async () => {
  mocks.refresh.mockResolvedValue({ user: { id: "u1" }, error: false });
  WelcomeBurst();
  const cleanup = mocks.effects[0]();
  if (cleanup) cleanup();
  window.location.href = "https://app.example.com/";
  mocks.effects[0]();
  await Promise.resolve();
  expect(mocks.set).toHaveBeenCalledTimes(2);
  expect(mocks.notify).not.toHaveBeenCalled();
  expect(mocks.reset).not.toHaveBeenCalled();
});
