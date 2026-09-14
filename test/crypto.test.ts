// lib/crypto — the shared hash and constant-time compare. Every stored credential (session,
// publish token, share token, passcode) goes through sha256hex, so its output shape is a storage
// contract; safeEqual guards every credential check, so its "never throws" property is what keeps a
// length-mismatched input from turning into a 500.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { safeEqual, sha256hex } from "@/lib/crypto";

describe("sha256hex", () => {
  it("is lowercase hex SHA-256 of the UTF-8 input", () => {
    expect(sha256hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const text = "秘密 ☃ token";
    expect(sha256hex(text)).toBe(createHash("sha256").update(text).digest("hex"));
    expect(sha256hex(text)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(sha256hex("same")).toBe(sha256hex("same"));
    expect(sha256hex("same")).not.toBe(sha256hex("Same"));
  });
});

describe("safeEqual", () => {
  it("is true for equal strings, including empty and multi-byte ones", () => {
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("token-1", "token-1")).toBe(true);
    expect(safeEqual("秘密", "秘密")).toBe(true);
  });

  it("is false for different strings of the same length", () => {
    expect(safeEqual("aaaa", "aaab")).toBe(false);
  });

  it("returns false (does not throw) on a length mismatch", () => {
    expect(() => safeEqual("short", "much longer")).not.toThrow();
    expect(safeEqual("short", "much longer")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
  });

  it("compares bytes, not code points — same length in chars, different in bytes, is a mismatch", () => {
    // "é" is two UTF-8 bytes, "e" is one: equal char length, unequal byte length, still just false.
    expect(safeEqual("é", "e")).toBe(false);
  });
});
