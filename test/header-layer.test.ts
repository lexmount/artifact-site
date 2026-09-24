import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../src/app/globals.css", import.meta.url)), "utf8");

describe("header layering", () => {
  it("keeps account menus above transformed home-page media", () => {
    const header = css.match(/\.site-header\s*\{([^}]*)\}/)?.[1] ?? "";

    const declarations = new Map(header.split(";").map(part => part.trim()).filter(Boolean).map(part => {
      const colon = part.indexOf(":");
      return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
    }));
    expect(declarations.get("position")).toBe("relative");
    expect(declarations.get("z-index")).toBe("20");
    expect(css).toMatch(/\.hero-art video\s*\{[^}]*transform:/);
  });
});
