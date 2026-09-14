#!/usr/bin/env node
// Refuse a branch whose squash-merge message would break a PaaS source build.
//
// Some build platforms store the commit message in a MySQL column truncated to 1024 BYTES. A Chinese
// character is three bytes, so a cut landing mid-character leaves half a code point, MySQL rejects
// the row with `Error 1366 Incorrect string value`, and the build fails — reported in the console
// as a bare "失败 ()" with no reason at all. It is not a hard ceiling so much as a lottery: a cut
// that happens to land on an ASCII boundary is fine, which is why a 1923-byte message once built
// and a 3799-byte one did not.
//
// What matters is the message that lands on the default branch, and GitHub's squash merge CONCATENATES every
// commit message in the PR. Keeping each individual commit short is therefore not enough — that
// is exactly how this got shipped twice.
import { execFileSync } from "node:child_process";

const LIMIT = 1024;
// The public repository's default branch is main; the private one it is exported from still uses master.
const base = process.argv[2] ?? (refExists("origin/main") ? "origin/main" : "origin/master");

function refExists(ref) {
  try { execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { stdio: "ignore" }); return true; } catch { return false; }
}

// execFileSync, not execSync: the latter runs its string through `/bin/sh -c`, which would make
// `base` — an argument this script is meant to be handed, including by CI from a PR's base ref —
// arbitrary shell. Passing an argv array never involves a shell at all.
function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

let subjects;
try {
  subjects = git("log", `${base}..HEAD`, "--pretty=%B%x00").split("\0").map((s) => s.trim()).filter(Boolean);
} catch {
  console.error(`Cannot read ${base}..HEAD — run git fetch first, or pass another base: node scripts/check-commit-msg.mjs <base>`);
  process.exit(2);
}

if (subjects.length === 0) {
  console.log(`No new commits relative to ${base}; nothing to check.`);
  process.exit(0);
}

// How GitHub composes a squash-merge body: every commit message, in order, blank-line separated.
const merged = subjects.join("\n\n");
const bytes = Buffer.byteLength(merged, "utf8");

console.log(`${subjects.length} commit(s) on the branch; the merged message is about ${bytes} bytes (limit ${LIMIT}).`);
for (const [i, s] of subjects.entries()) {
  console.log(`  ${i + 1}. ${Buffer.byteLength(s, "utf8")} bytes  ${s.split("\n")[0].slice(0, 50)}`);
}

if (bytes <= LIMIT) {
  console.log("✓ Within the limit.");
  process.exit(0);
}

// Show where the cut would land, since a mid-character cut is the actual failure.
const cut = Buffer.from(merged, "utf8").subarray(LIMIT - 3, LIMIT);
const splitsChar = Buffer.from(merged, "utf8").subarray(0, LIMIT).toString("utf8").endsWith("�");

console.error(`\n✗ Over by ${bytes - LIMIT} bytes.`);
console.error(`  Around byte ${LIMIT}: ${[...cut].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
console.error(splitsChar
  ? "  The cut lands in the middle of a multi-byte character — merged as is, the build will fail."
  : "  The cut happens to land on a character boundary, so the build may get lucky this time — do not count on it.");
console.error("\nWhen merging the PR, edit the body by hand in GitHub's merge dialog and keep it under 1024 bytes.");
process.exit(1);
