import { afterEach, expect, it, vi } from "vitest";
import { registerClientCache } from "@/lib/client-cache";
import { siteFetch } from "@/lib/share-context";
afterEach(() => vi.unstubAllGlobals());
it("invalidates successful mutations except the exact permission read POST", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  const clear = vi.fn();
  registerClientCache(clear);
  await siteFetch("/api/sites/s/permissions?share=fixture", {method:"POST"});
  await siteFetch("/api/sites/s/permissions");
  expect(clear).not.toHaveBeenCalled();
  await siteFetch("/api/sites/s/sharing?note=/permissions", {method:"PUT"});
  await siteFetch("/api/sites/s/permissions", {method:"PATCH"});
  expect(clear).toHaveBeenCalledTimes(2);
});
