import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { URL_LOCALE_COOKIE, URL_LOCALE_HEADER } from "@/lib/i18n";

describe("URL locale proxy", () => {
  it("forwards a supported lang and remembers it for this browser session", () => {
    const response = proxy(new NextRequest("https://example.test/s/a?lang=zh-CN"));
    expect(response.headers.get(`x-middleware-request-${URL_LOCALE_HEADER}`)).toBe("zh-CN");
    expect(response.cookies.get(URL_LOCALE_COOKIE)?.value).toBe("zh-CN");
    expect(response.cookies.getAll()).toHaveLength(1);
  });

  it("ignores unsupported languages", () => {
    const response = proxy(new NextRequest("https://example.test/?lang=fr"));
    expect(response.headers.get(`x-middleware-request-${URL_LOCALE_HEADER}`)).toBeNull();
    expect(response.cookies.get(URL_LOCALE_COOKIE)).toBeUndefined();
  });

  it("removes a client-supplied internal locale header", () => {
    const response = proxy(
      new NextRequest("https://example.test/", {
        headers: { [URL_LOCALE_HEADER]: "zh-CN" },
      }),
    );
    expect(response.headers.get(`x-middleware-request-${URL_LOCALE_HEADER}`)).toBeNull();
    expect(response.headers.get("x-middleware-override-headers")?.split(",")).not.toContain(URL_LOCALE_HEADER);
  });

  it("lets a supported URL locale replace a client-supplied header", () => {
    const response = proxy(
      new NextRequest("https://example.test/?lang=en", {
        headers: { [URL_LOCALE_HEADER]: "zh-CN" },
      }),
    );
    expect(response.headers.get(`x-middleware-request-${URL_LOCALE_HEADER}`)).toBe("en");
  });
});
