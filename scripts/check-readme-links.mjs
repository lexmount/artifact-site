#!/usr/bin/env node
// Checks every relative link, image and anchor in the README and its translations the way GitHub
// resolves them: the target file must exist, and a #fragment must match a heading in the target
// (GitHub's slug rule: lowercase, keep letters, numbers, spaces, hyphens and underscores, drop the
// rest, spaces become hyphens). Anchors are per language, so each translation is checked against
// its own headings. Exits non-zero on the first problem list.
//
//   node scripts/check-readme-links.mjs             # the README and everything in docs/README.*.md
//   node scripts/check-readme-links.mjs FILE.md …   # specific files, relative to the repository root
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = process.argv.length > 2
  ? process.argv.slice(2)
  : ["README.md", ...readdirSync(path.join(root, "docs")).filter((f) => /^README\..+\.md$/.test(f)).sort().map((f) => `docs/${f}`)];

const slugify = (text) => text.trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "").replace(/\s/g, "-");

const stripInline = (s) => s
  .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
  .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/<[^>]+>/g, "")
  .replace(/`([^`]*)`/g, "$1")
  .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1");

// Lines of a markdown file with fenced code removed, so nothing inside a code block counts.
const proseLines = (file) => {
  const out = []; let inFence = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (!inFence) out.push(line);
  }
  return out;
};

const headingsOf = (file) => {
  const seen = new Map(); const out = new Set();
  for (const line of proseLines(file)) {
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line) ?? /<h[1-6][^>]*>(.*?)<\/h[1-6]>/.exec(line);
    if (!m) continue;
    let slug = slugify(stripInline(m[1]));
    const n = seen.get(slug) ?? 0; seen.set(slug, n + 1);
    if (n) slug = `${slug}-${n}`;
    out.add(slug);
  }
  return out;
};

let problems = 0, checked = 0;
for (const rel of files) {
  const file = path.resolve(root, rel);
  const targets = [];
  for (const line of proseLines(file)) {
    for (const m of line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) targets.push(m[1]);
    for (const m of line.matchAll(/\b(?:href|src)="([^"]+)"/g)) targets.push(m[1]);
    for (const m of line.matchAll(/\bsrcset="([^"]+)"/g)) for (const part of m[1].split(",")) targets.push(part.trim().split(/\s+/)[0]);
  }
  let bad = 0;
  for (const raw of targets) {
    if (/^(https?:|mailto:|data:)/.test(raw)) continue;
    checked++;
    const [p, anchor] = raw.split("#");
    const target = p ? path.resolve(path.dirname(file), decodeURI(p)) : file;
    if (!existsSync(target)) { console.log(`✗ ${rel}: missing target ${raw}`); bad++; continue; }
    if (anchor !== undefined) {
      if (statSync(target).isDirectory()) { console.log(`✗ ${rel}: anchor on a directory ${raw}`); bad++; continue; }
      if (!headingsOf(target).has(anchor)) { console.log(`✗ ${rel}: no heading for anchor ${raw}`); bad++; }
    }
  }
  problems += bad;
  console.log(`${bad ? "✗" : "✓"} ${rel}: ${targets.length} references`);
}
console.log(`${checked} relative references checked, ${problems} problem(s)`);
process.exit(problems ? 1 : 0);
