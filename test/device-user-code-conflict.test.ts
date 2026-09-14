// POST /api/device/start regenerates the user code on a UNIQUE collision — and ONLY on that. The
// store has to report the collision as a typed error for the route to tell it apart from a
// connection failure, which must not be retried and mis-reported.
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDbForTests, insertDeviceGrant, UserCodeConflictError } from "@/lib/db";

afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock("@/lib/db");
  vi.resetModules();
  await closeDbForTests();
});

describe("device grant user_code collision", () => {
  it("the store throws UserCodeConflictError for a duplicate user_code", async () => {
    const now = Date.now();
    await insertDeviceGrant({ deviceCode: "dc-one", userCode: "ABCD-EFGH", createdAt: now, expiresAt: now + 60_000 });
    await expect(insertDeviceGrant({ deviceCode: "dc-two", userCode: "ABCD-EFGH", createdAt: now, expiresAt: now + 60_000 }))
      .rejects.toBeInstanceOf(UserCodeConflictError);
  });

  it("the route retries a collision with a fresh code, but surfaces any other failure at once", async () => {
    vi.resetModules();
    const insert = vi.fn<(g: { userCode: string }) => Promise<void>>();
    vi.doMock("@/lib/db", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/db")>()),
      insertDeviceGrant: insert,
    }));
    // The route and this test must share ONE class identity for the instanceof check, so take it
    // from the module instance the route will import — not from the top-level import above.
    const db = await import("@/lib/db");
    const { POST } = await import("@/app/api/device/start/route");
    vi.spyOn(console, "error").mockImplementation(() => {});

    insert.mockRejectedValueOnce(new db.UserCodeConflictError()).mockResolvedValueOnce(undefined);
    const ok = await POST(new Request("http://x/api/device/start", { method: "POST" }));
    expect(ok.status).toBe(200);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert.mock.calls[0][0].userCode).not.toBe(insert.mock.calls[1][0].userCode);

    insert.mockClear();
    insert.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const failed = await POST(new Request("http://x/api/device/start", { method: "POST" }));
    expect(failed.status).toBe(500);
    expect(insert).toHaveBeenCalledTimes(1); // no retry for a non-collision failure
  });
});
