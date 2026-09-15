// The parts of lib/share that need no database: token/passcode hashing, liveness, and the passcode
// grant cookie. The cookie is the interesting one — it is what lets a reader who typed a code keep
// reading the artifact's sub-resources, and it is stateless, so its invalidation rules live entirely
// in how the value is computed.
import { describe, expect, it } from "vitest";
import {
  buildPasscodeCookie,
  createPasscode,
  createShareToken,
  hasPasscodeCookie,
  hashPasscode,
  hashToken,
  isLive,
} from "@/lib/share";
import type { ShareRow } from "@/lib/types";

const share = (over: Partial<ShareRow> = {}): ShareRow => ({
  id: "shr_1",
  siteId: "site_1",
  mode: "view", versionId: null,
  tokenHash: "th",
  policy: "passcode",
  allowAi: false,
  passcodeHash: hashPasscode("ABC234"),
  hasPasscode: true,
  label: null,
  createdBy: null,
  createdAnonId: null,
  createdAt: 0,
  expiresAt: null,
  revokedAt: null,
  ...over,
});

const req = (headers: Record<string, string> = {}) => new Request("https://x/v/tok", { headers });

/** Pull the cookie's value back out of a Set-Cookie string, as a browser would send it. */
const asCookieHeader = (setCookie: string) => setCookie.split(";")[0];

describe("tokens and passcodes", () => {
  it("mints high-entropy, URL-safe tokens", () => {
    const a = createShareToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{30,}$/);
    expect(createShareToken()).not.toBe(a);
  });

  // These get read aloud and retyped off a screen, so the confusable glyphs are excluded on purpose.
  it("mints passcodes with no 0/O/1/I/L to mistype", () => {
    for (let i = 0; i < 40; i += 1) {
      expect(createPasscode()).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    }
  });

  it("hashes rather than stores — a dump yields no working link", () => {
    const token = createShareToken();
    expect(hashToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it("treats a passcode case- and whitespace-insensitively", () => {
    expect(hashPasscode("abc234")).toBe(hashPasscode("ABC234"));
    expect(hashPasscode("  ABC234 ")).toBe(hashPasscode("ABC234"));
    expect(hashPasscode("ABC235")).not.toBe(hashPasscode("ABC234"));
  });
});

describe("isLive", () => {
  it("is false once revoked, whatever the expiry says", () => {
    expect(isLive(share({ revokedAt: 1 }))).toBe(false);
    expect(isLive(share({ revokedAt: 1, expiresAt: Date.now() + 1e6 }))).toBe(false);
  });

  it("treats a null expiry as never expiring", () => {
    expect(isLive(share({ expiresAt: null }))).toBe(true);
  });

  it("is false at and after the expiry instant", () => {
    const now = 1_000_000;
    expect(isLive(share({ expiresAt: now + 1 }), now)).toBe(true);
    expect(isLive(share({ expiresAt: now }), now)).toBe(false);
  });
});

describe("passcode grant cookie", () => {
  it("round-trips: a cookie it issued is one it accepts", () => {
    const s = share();
    const cookie = asCookieHeader(buildPasscodeCookie(req(), s));
    expect(hasPasscodeCookie(req({ cookie }), s)).toBe(true);
  });

  it("is scoped to one share — it does not open a sibling", () => {
    const cookie = asCookieHeader(buildPasscodeCookie(req(), share({ id: "shr_1" })));
    expect(hasPasscodeCookie(req({ cookie }), share({ id: "shr_2" }))).toBe(false);
  });

  // The passcode hash is an input to the signature, so rotating the code invalidates every cookie
  // already handed out. That is the whole reason the grant needs no table of its own.
  it("dies when the passcode is rotated", () => {
    const before = share();
    const cookie = asCookieHeader(buildPasscodeCookie(req(), before));
    expect(hasPasscodeCookie(req({ cookie }), share({ passcodeHash: hashPasscode("ZZZ999") }))).toBe(false);
  });

  it("refuses a forged or tampered value", () => {
    const s = share();
    const real = asCookieHeader(buildPasscodeCookie(req(), s));
    const tampered = real.replace(/\.[a-f0-9]+$/, ".deadbeef");
    expect(hasPasscodeCookie(req({ cookie: tampered }), s)).toBe(false);
    expect(hasPasscodeCookie(req({ cookie: `ah_pass_${s.id}=9999999999999.abc` }), s)).toBe(false);
    expect(hasPasscodeCookie(req(), s)).toBe(false);
  });

  it("carries Secure only over https, and is always HttpOnly", () => {
    const s = share();
    expect(buildPasscodeCookie(req(), s)).toContain("Secure");
    expect(buildPasscodeCookie(req(), s)).toContain("HttpOnly");
    const plain = new Request("http://x/v/tok", { headers: { "x-forwarded-proto": "http" } });
    expect(buildPasscodeCookie(plain, s)).not.toContain("Secure");
  });
});
