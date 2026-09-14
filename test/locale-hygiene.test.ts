// The reverse of "every t() string has a translation": every zh-CN key is still referenced by some
// source file, as a string literal — directly in t("…"), or through a label table whose values are
// literals. Keys that survive only in the locale files are how 43 stale entries accumulated.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const abs = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}
const sources = walk(abs("src")).filter((f) => !f.includes("/locales/")).map((f) => readFileSync(f, "utf8")).join("\n");
const literals = new Set([...sources.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((m) => m[1].replace(/\\"/g, '"')));

describe("zh-CN locale hygiene", () => {
  for (const file of readdirSync(abs("src/locales/zh-CN")).filter((f) => f.endsWith(".ts") && f !== "index.ts")) {
    it(`${file}: every key is referenced by a source string literal`, () => {
      const src = readFileSync(abs(`src/locales/zh-CN/${file}`), "utf8");
      const keys = [...src.matchAll(/^\s*"((?:[^"\\]|\\.)*)":/gm)].map((m) => m[1].replace(/\\"/g, '"'));
      expect(keys.length).toBeGreaterThan(0);
      const stale = keys.filter((k) => !literals.has(k));
      expect(stale, `没有源码引用的键：${stale.map((k) => k.slice(0, 60)).join(" | ")}`).toEqual([]);
    });
  }
});
