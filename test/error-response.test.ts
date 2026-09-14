// app/api/_util.errorResponse — the one error → HTTP mapping every route ends in. The contract:
// an error that was written for the caller (statusCode, Zod, malformed JSON) is answered with its
// message; anything else is an internal fault and must NOT be echoed — a driver's or a library's
// message is one step from a stack trace, and the operator reads it in the log instead.
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorResponse, PayloadTooLargeError } from "@/app/api/_util";
import { AuthError, EditForbiddenError } from "@/lib/auth";
import { BadRequestError } from "@/lib/errors";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("errorResponse", () => {
  it("maps statusCode-carrying errors to their status with the message intact", async () => {
    for (const [error, status] of [
      [new BadRequestError("The upload is empty"), 400],
      [new AuthError(), 401],
      [new EditForbiddenError(), 403],
      [new PayloadTooLargeError(), 413],
    ] as const) {
      const res = errorResponse(error);
      expect(res.status).toBe(status);
      expect((await res.json()).error).toBe(error.message);
    }
  });

  it("answers Zod failures with 400 and the issue list", async () => {
    let caught: unknown;
    try {
      z.object({ mode: z.literal("paste") }).parse({ mode: "nope" });
    } catch (e) {
      caught = e;
    }
    const res = errorResponse(caught);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid request body");
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it("answers a malformed JSON body (SyntaxError) with 400", async () => {
    let caught: unknown;
    try {
      JSON.parse("{not json");
    } catch (e) {
      caught = e;
    }
    const res = errorResponse(caught);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^invalid request body: /);
  });

  it("answers an unknown error with a generic 500 and logs it, never echoing the message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = errorResponse(new Error("connect ECONNREFUSED 10.0.0.7:5432 (secret-host)"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "internal error" });
    expect(JSON.stringify(body)).not.toContain("secret-host");
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][1])).toContain("secret-host");
  });

  it("treats Node system errors (syscall + path) the same way", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sys = Object.assign(new Error("ENOSPC: no space left on device, write '/data/sites/x'"), { syscall: "write", code: "ENOSPC" });
    const res = errorResponse(sys);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("internal error");
  });

  it("treats a thrown non-Error value as internal too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = errorResponse("a string somebody threw");
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("internal error");
  });
});
