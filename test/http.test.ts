// lib/http — the one copy of "was this request TLS?" and "read exactly one cookie" that the
// session, anonymous-id, OIDC-flow and share-passcode paths all share. Pinned here so a change
// to either helper is a deliberate change to every cookie name and every cookie read at once.
import { describe, expect, it } from "vitest";
import { forwardedProto, isSecureRequest, readCookie } from "@/lib/http";

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe("isSecureRequest", () => {
  it("is true for an https request URL regardless of headers", () => {
    expect(isSecureRequest(req("https://x/"))).toBe(true);
    expect(isSecureRequest(req("https://x/", { "x-forwarded-proto": "http" }))).toBe(true);
  });

  it("follows x-forwarded-proto: https on a plain-http URL", () => {
    expect(isSecureRequest(req("http://x/", { "x-forwarded-proto": "https" }))).toBe(true);
  });

  it("is false when the proxy says http", () => {
    expect(isSecureRequest(req("http://x/", { "x-forwarded-proto": "http" }))).toBe(false);
  });

  it("defaults to NOT secure when the header is absent (plain-http dev must keep its cookies)", () => {
    expect(isSecureRequest(req("http://x/"))).toBe(false);
  });

  it("reads only the FIRST hop of a multi-hop header", () => {
    expect(isSecureRequest(req("http://x/", { "x-forwarded-proto": "https, http" }))).toBe(true);
    expect(isSecureRequest(req("http://x/", { "x-forwarded-proto": "http, https" }))).toBe(false);
    expect(isSecureRequest(req("http://x/", { "x-forwarded-proto": " https ,http" }))).toBe(true);
  });
});

describe("forwardedProto", () => {
  it("returns the trimmed first hop, or an empty string", () => {
    expect(forwardedProto(new Headers())).toBe("");
    expect(forwardedProto(new Headers({ "x-forwarded-proto": "https" }))).toBe("https");
    expect(forwardedProto(new Headers({ "x-forwarded-proto": " http , https" }))).toBe("http");
  });

  it("accepts any header bag with a get()", () => {
    const bag = { get: (name: string) => (name === "x-forwarded-proto" ? "https" : null) };
    expect(forwardedProto(bag)).toBe("https");
  });
});

describe("readCookie", () => {
  it("returns null with no cookie header, and null for a name that is not present", () => {
    expect(readCookie(req("http://x/"), "a")).toBeNull();
    expect(readCookie(req("http://x/", { cookie: "b=2" }), "a")).toBeNull();
  });

  it("returns the value of a single matching cookie, ignoring neighbours and whitespace", () => {
    expect(readCookie(req("http://x/", { cookie: "b=2;  a=1 ; c=3" }), "a")).toBe("1");
  });

  it("matches the whole name, not a prefix", () => {
    expect(readCookie(req("http://x/", { cookie: "ab=2; a=1" }), "a")).toBe("1");
    // A cookie whose name merely starts with the looked-up name must not satisfy the lookup.
    expect(readCookie(req("http://x/", { cookie: "ab=2" }), "a")).toBeNull();
  });

  it("REJECTS an ambiguous duplicate rather than picking one", () => {
    // A sibling subdomain can plant a second copy with Domain=.example.com; refusing is safer.
    expect(readCookie(req("http://x/", { cookie: "a=1; a=2" }), "a")).toBeNull();
    expect(readCookie(req("http://x/", { cookie: "a=1; b=0; a=1" }), "a")).toBeNull();
  });

  it("URL-decodes the value", () => {
    expect(readCookie(req("http://x/", { cookie: `a=${encodeURIComponent("x/y z=1")}` }), "a")).toBe("x/y z=1");
  });

  it("keeps an empty value distinct from absence", () => {
    expect(readCookie(req("http://x/", { cookie: "a=" }), "a")).toBe("");
  });
});

describe("readCookie — malformed values", () => {
  it("treats a broken percent-escape as an absent cookie instead of throwing", () => {
    const request = new Request("https://x/", { headers: { cookie: "s=%E0%A4%A; other=1" } });
    expect(() => readCookie(request, "s")).not.toThrow();
    expect(readCookie(request, "s")).toBeNull();
    expect(readCookie(request, "other")).toBe("1");
  });
});
