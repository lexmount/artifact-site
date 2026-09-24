import { describe, expect, it, vi } from "vitest";
import { RequestCache } from "@/lib/request-cache";
describe("request leases", () => {
  it("deduplicates, retains successful data, and isolates credentials", async () => {
    const cache = new RequestCache<number>();
    const fetcher = vi.fn(async () => 42);
    const a = cache.acquire("alice:site", fetcher),
      b = cache.acquire("alice:site", fetcher);
    expect(await a.promise).toBe(42);
    expect(await b.promise).toBe(42);
    a.release();
    b.release();
    const c = cache.acquire("alice:site", fetcher);
    await c.promise;
    c.release();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await cache.acquire("bob:site", fetcher).promise;
    expect(fetcher).toHaveBeenCalledTimes(2);
    cache.clear();
    await cache.acquire("alice:site", fetcher).promise;
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("bounds retained keys without cancelling active subscribers", async () => {
    const cache = new RequestCache<number>(30_000, 1);
    let finish!: (n:number)=>void;
    const first = vi.fn(() => new Promise<number>(resolve => {finish=resolve;}));
    const a = cache.acquire("active",first);
    const overflow = vi.fn(async()=>2);
    const b = cache.acquire("overflow",overflow);
    await b.promise;
    b.release();
    await cache.acquire("overflow",overflow).promise;
    expect(overflow).toHaveBeenCalledTimes(2);
    const same = cache.acquire("active",first);
    expect(first).toHaveBeenCalledTimes(1);
    finish(1);
    expect(await same.promise).toBe(1);
    a.release(); same.release();
  });
  it("refreshes grants after expiry", async () => {
    const cache = new RequestCache<number>(0);
    const first = cache.acquire("identity",async()=>1);
    expect(await first.promise).toBe(1);
    first.release();
    expect(await cache.acquire("identity",async()=>2).promise).toBe(2);
  });
  it("cancels only when the last subscriber leaves and retries failures", async () => {
    const cache = new RequestCache<number>();
    let signal: AbortSignal;
    const run = (s: AbortSignal) => {
      signal = s;
      return new Promise<number>((_, reject) =>
        s.addEventListener("abort", () => reject(new Error("cancelled"))),
      );
    };
    const a = cache.acquire("x", run),
      b = cache.acquire("x", run);
    const caught = a.promise.catch((e) => e.message);
    a.release();
    expect(signal!.aborted).toBe(false);
    b.release();
    await new Promise((r) => setTimeout(r, 5));
    expect(await caught).toBe("cancelled");
    expect(await cache.acquire("x", async () => 7).promise).toBe(7);
  });
});
