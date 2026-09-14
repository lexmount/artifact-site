// globals.css hygiene: every class it styles is used by some component, no top-level selector sets
// the same property in two places (the design pass folds its overrides instead of stacking them), and
// reduced motion is decided in one place. These are the three ways the file grew stale before.
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
const sources = walk(abs("src")).map((f) => readFileSync(f, "utf8")).join("\n");
const css = readFileSync(abs("src/app/globals.css"), "utf8");
const code = css.replace(/\/\*[\s\S]*?\*\//g, " ");

describe("globals.css hygiene", () => {
  it("styles no class that no component uses", () => {
    // Classes built from a template (`vis-${visibility}`, `is-site-${action}`) are matched by their prefix.
    const prefixes = [...sources.matchAll(/([a-zA-Z_][\w-]*-)\$\{/g)].map((m) => m[1]);
    const declared = new Set([...code.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]));
    const orphans = [...declared].filter((c) => !sources.includes(c) && !prefixes.some((p) => c.startsWith(p)));
    expect(orphans, `globals.css 里这些类没有任何组件使用：${orphans.join(", ")}`).toEqual([]);
  });

  it("never declares the same property twice for one top-level selector — a later rule that contradicts an earlier one is folded, not stacked", () => {
    // A selector may still appear more than once (the design pass adds properties the older rule never
    // set, and moving declarations would change shorthand/longhand interplay with rules in between),
    // but no property of it may be set in two places: the earlier value would be dead weight that
    // misleads whoever reads the first rule.
    const props = new Map<string, string[]>();
    let depth = 0;
    for (const m of code.matchAll(/([^{}]+)\{([^{}]*)\}|([^{}]+)\{|\}/g)) {
      if (m[0] === "}") { depth -= 1; continue; }
      if (m[3] !== undefined) { depth += 1; continue; }
      const sel = m[1].trim();
      if (depth === 0) {
        const list = props.get(sel) ?? [];
        for (const d of m[2].split(/;(?![^(]*\))/)) { const p = d.split(":")[0].trim(); if (p) list.push(p); }
        props.set(sel, list);
      }
    }
    const stacked = [...props].flatMap(([sel, list]) => {
      const seen = new Set<string>(); const dup = new Set<string>();
      for (const p of list) { if (seen.has(p)) dup.add(p); seen.add(p); }
      return dup.size ? [`${sel} → ${[...dup].join(", ")}`] : [];
    });
    expect(stacked, `同一选择器重复声明了同一属性：${stacked.join(" | ")}`).toEqual([]);
  });

  it("has one reduced-motion block, and it keeps the progress spinner turning", () => {
    expect(code.match(/prefers-reduced-motion/g)).toHaveLength(1);
    const block = code.slice(code.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toContain(".spin { animation: spin 1.6s linear infinite !important; }");
  });
});
