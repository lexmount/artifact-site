// The publish skill, surfaced on the web so an agent can fetch one URL and learn to use the platform.
// src/content/publish-skill.md is a byte-for-byte copy of the installed skill (frontmatter + body) —
// the single source of truth. It is force-included into the standalone bundle via next.config's
// outputFileTracingIncludes and read from process.cwd() (the app root, /app, in Docker — the same
// base config.ts already trusts). Served verbatim at /for-agents.md; rendered for humans at /for-agents.
//
// Nobody FETCHING the skill ever has to fill a base URL in — it arrives already pointing at the
// deployment that served it. The committed markdown spells out one address (DEFAULT_BASE below) and
// this module rewrites it to whatever origin the request resolved to, so a self-hosted instance
// documents itself. The committed address is a neutral placeholder, never a real deployment. Operators set that origin once, with the
// ARTIFACT_PUBLIC_URL they already need for OIDC and the CSRF gate.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import { forwardedProto } from "@/lib/http";

/**
 * The origin written into src/content/publish-skill.md. Two jobs: it is what gets swapped out at
 * serve time, and it is the last-resort answer when neither ARTIFACT_PUBLIC_URL nor a Host header
 * says otherwise. Keep it EQUAL to the address in the markdown — a mismatch silently disables the
 * rewrite (nothing to find), which the parity test below turns into a failure rather than a mystery.
 */
export const DEFAULT_BASE = "https://artifact-site.example.com";

/** Response header every API answer and /for-agents.md carry: the version of the guide this deployment serves. */
export const SKILL_VERSION_HEADER = "x-artifact-site-skill-version";
/** The header under the product's previous name — still sent, so copies of the guide from before the rename keep verifying. */
export const LEGACY_SKILL_VERSION_HEADER = "x-artifact-hub-skill-version";

/**
 * A version that nobody has to remember to bump: the first 12 hex digits of the committed text's
 * SHA-256. Any edit to the guide changes it; two deployments running the same build agree on it.
 * Computed on the COMMITTED text, before the base URL and the version line itself are written in,
 * so every deployment of one build reports the same value whatever address it serves under.
 */
export function skillVersionOf(committedText: string): string {
  return createHash("sha256").update(committedText, "utf8").digest("hex").slice(0, 12);
}

let cachedRaw: string | null = null;
let cachedVersion: string | null = null;

export function getSkillVersion(): string {
  if (cachedVersion == null) cachedVersion = skillVersionOf(getSkillMarkdown());
  return cachedVersion;
}

/** The skill's markdown exactly as committed, base URL not yet rewritten. Cached — the file never
 *  changes at runtime. Prefer `getSkillForBase` unless you specifically want the committed text. */
export function getSkillMarkdown(): string {
  if (cachedRaw == null) {
    cachedRaw = readFileSync(path.join(process.cwd(), "src/content/publish-skill.md"), "utf8");
  }
  return cachedRaw;
}

/**
 * The skill as this deployment should hand it out: every occurrence of DEFAULT_BASE replaced with
 * `base`. Split/join rather than a regex so a base containing `$&` or `$1` cannot corrupt the output.
 */
export function getSkillForBase(base: string): string {
  const raw = getSkillMarkdown();
  const rebased = base === DEFAULT_BASE ? raw : raw.split(DEFAULT_BASE).join(base);
  return withVersionLine(rebased, getSkillVersion());
}

/** `skill_version: <v>` as the first frontmatter line after `name:`, so a saved copy carries the
 *  version it was fetched at. A file without the line did not come from a platform. */
function withVersionLine(text: string, version: string): string {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return text;
  const lines = m[1].split("\n").filter((l) => !l.startsWith("skill_version:"));
  const at = lines.findIndex((l) => l.startsWith("name:"));
  lines.splice(at >= 0 ? at + 1 : 0, 0, `skill_version: ${version}`);
  return `---\n${lines.join("\n")}\n---\n` + text.slice(m[0].length);
}

export interface ParsedSkill {
  meta: { name?: string; description?: string };
  body: string; // everything after the frontmatter, for rendering
}

/** Split the leading `--- … ---` YAML frontmatter (simple key: value lines) from the body, with the
 *  base URL already rewritten for `base` — the rendered page must show the same address the raw
 *  endpoint serves, or a reader following the page would post somewhere else than an agent would. */
export function parseSkill(base: string): ParsedSkill {
  const raw = getSkillForBase(base);
  const m = raw.match(/^---\n([\s\S]*?)\n---\n*/);
  if (!m) return { meta: {}, body: raw };
  const meta: { name?: string; description?: string } = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (key === "name" || key === "description") meta[key] = value;
  }
  return { meta, body: raw.slice(m[0].length) };
}

/**
 * This deployment's public origin — both the copy-me skill URL on the page and the base written into
 * the skill it serves. Prefers the operator's ARTIFACT_PUBLIC_URL (the same value OIDC redirects and
 * the CSRF gate are built from, so there is one address to configure, not three), then the forwarded
 * Host so an unconfigured instance still describes itself, then the placeholder DEFAULT_BASE.
 * Normalised once at the end, so every branch is trailing-slash-free regardless of its own input.
 */
export function resolvePublicBase(headers: { get(name: string): string | null }): string {
  const base = config.publicUrl || originFromForwardedHost(headers) || DEFAULT_BASE;
  return base.replace(/\/+$/, "");
}

// A hostname, optionally with a port — nothing else. Both header values below are attacker-supplied
// on any deployment whose app port is reachable without the gateway rewriting them.
const HOST_RE = /^[a-zA-Z0-9.-]+(:\d{1,5})?$/;

function originFromForwardedHost(headers: { get(name: string): string | null }): string {
  const host = headers.get("host");
  // Reject anything that is not a bare host: this value ends up substituted INTO the skill markdown,
  // which /for-agents renders through marked into dangerouslySetInnerHTML. Today the one occurrence
  // of DEFAULT_BASE sits inside a backtick code span, so marked escapes it and a payload like
  // `evil"><img src=x onerror=…>` is inert — verified. But that safety is incidental to how one line
  // of a markdown file happens to be punctuated: move the address out of the code span and the same
  // header becomes stored XSS. Validate here, where the untrusted value enters, not there.
  if (!host || !HOST_RE.test(host)) return "";
  // Constrain the forwarded proto to the two schemes we actually serve — never echo an
  // attacker-supplied value like `javascript` into the URL we hand out. The default is the
  // OPPOSITE of lib/http.isSecureRequest on purpose: this mints an address for agents to call,
  // and a production deployment is TLS, so an absent header means https here, not http.
  const proto = forwardedProto(headers) === "http" ? "http" : "https";
  return `${proto}://${host}`;
}
