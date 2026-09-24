import { describe, expect, it, vi } from "vitest";
import { PostgresStore } from "@/lib/db-postgres";
describe("standalone Postgres query connection lifecycle", () => {
  it("discards a failed connection and propagates the original error", async () => {
    const error = new Error("connection terminated");
    const release = vi.fn();
    const store = new PostgresStore();
    Reflect.set(store, "pool", { connect: async () => ({ query: vi.fn().mockRejectedValue(error), release }) });
    await expect(store.rbacQuery("SELECT 1")).rejects.toBe(error);
    expect(release).toHaveBeenCalledExactlyOnceWith(error);
  });
  it("returns a healthy connection after a successful query", async () => {
    const release = vi.fn();
    const store = new PostgresStore();
    Reflect.set(store, "pool", { connect: async () => ({ query: async () => ({rows:[{n:1}]}), release }) });
    expect(await store.rbacQuery("SELECT 1 AS n")).toEqual([{n:1}]);
    expect(release).toHaveBeenCalledExactlyOnceWith(undefined);
  });
});
