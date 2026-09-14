import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_BASE, getSkillForBase, getSkillMarkdown, getSkillVersion, parseSkill, resolvePublicBase, skillVersionOf, SKILL_VERSION_HEADER } from "@/lib/publish-skill";
import { json } from "@/app/api/_util";
import { GET as publishMdGET } from "@/app/for-agents.md/route";

const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

afterEach(() => { delete process.env.ARTIFACT_PUBLIC_URL; });

describe("publish skill source", () => {
  it("is byte-for-byte the installed SKILL.md content", () => {
    const onDisk = readFileSync(path.join(process.cwd(), "src/content/publish-skill.md"), "utf8");
    expect(getSkillMarkdown()).toBe(onDisk);
    expect(onDisk).toContain("name: publish-to-artifact-site"); // frontmatter is preserved
  });

  // The rewrite is a plain find-and-replace, so if the committed markdown ever spells its address
  // differently from DEFAULT_BASE there is simply nothing to find: every deployment would keep
  // handing out the hard-coded host and no test would notice. Pin the two together.
  it("the address written in the markdown IS DEFAULT_BASE", () => {
    expect(getSkillMarkdown()).toContain(DEFAULT_BASE);
  });

  it("parseSkill splits frontmatter from body", () => {
    const { meta, body } = parseSkill(DEFAULT_BASE);
    expect(meta.name).toBe("publish-to-artifact-site");
    expect(meta.description).toBeTruthy();
    expect(meta.description).toContain("artifact-site");
    expect(body.startsWith("# Publishing artifacts to artifact-site")).toBe(true);
    expect(body).not.toContain("---\nname:"); // body must not carry the frontmatter
  });

  it("parseSkill rewrites the base in the body it renders", () => {
    const { body } = parseSkill("https://sites.acme.internal");
    expect(body).toContain("https://sites.acme.internal");
    expect(body).not.toContain(DEFAULT_BASE);
  });
});

describe("base URL rewriting", () => {
  it("swaps every occurrence for the given base", () => {
    const out = getSkillForBase("https://sites.acme.internal");
    expect(out).not.toContain(DEFAULT_BASE);
    expect(out).toContain("https://sites.acme.internal");
    // Only the host changes — the document is otherwise untouched, frontmatter included.
    expect(out.startsWith("---\nname: publish-to-artifact-site")).toBe(true);
    expect(out.split("https://sites.acme.internal").length)
      .toBe(getSkillMarkdown().split(DEFAULT_BASE).length);
  });

  it("is a no-op when the base already is the default (apart from the version line every served copy carries)", () => {
    expect(getSkillForBase(DEFAULT_BASE).replace(/^skill_version: [0-9a-f]{12}\n/m, "")).toBe(getSkillMarkdown());
  });

  // split/join, not String.replace — `$&` in a replacement string would otherwise expand.
  it("treats a base containing $-sequences literally", () => {
    expect(getSkillForBase("https://a$&b.example")).toContain("https://a$&b.example");
  });
});

describe("resolvePublicBase", () => {
  it("prefers ARTIFACT_PUBLIC_URL and strips its trailing slash", () => {
    process.env.ARTIFACT_PUBLIC_URL = "https://configured.example/";
    expect(resolvePublicBase(req("https://ignored.example/x").headers)).toBe("https://configured.example");
  });

  it("falls back to the forwarded Host so an unconfigured instance describes itself", () => {
    const headers = new Headers({ host: "derived.example", "x-forwarded-proto": "https" });
    expect(resolvePublicBase(headers)).toBe("https://derived.example");
  });

  it("falls back to DEFAULT_BASE with no config and no Host", () => {
    expect(resolvePublicBase(new Headers())).toBe(DEFAULT_BASE);
  });

  // The Host value is substituted INTO the skill markdown, which /for-agents renders through marked
  // into dangerouslySetInnerHTML. Today the sole occurrence of DEFAULT_BASE sits in a backtick code
  // span so marked escapes it — but that is incidental punctuation, not a control. Reject anything
  // that is not a bare host here, at the point the untrusted value enters.
  it.each([
    ['evil"><img src=x onerror=alert(1)>', "markup"],
    ["evil.example/path", "a path"],
    ["evil.example evil2.example", "whitespace"],
    ["user@evil.example", "userinfo"],
    ["evil.example:notaport", "a non-numeric port"],
  ])("refuses a Host containing %s and falls back instead", (host) => {
    expect(resolvePublicBase(new Headers({ host }))).toBe(DEFAULT_BASE);
  });

  it("accepts an ordinary host, with or without a port", () => {
    expect(resolvePublicBase(new Headers({ host: "sites.acme.internal" }))).toBe("https://sites.acme.internal");
    expect(resolvePublicBase(new Headers({ host: "sites.acme.internal:8443" }))).toBe("https://sites.acme.internal:8443");
  });
});

describe("GET /for-agents.md", () => {
  it("serves markdown whose base is this deployment's origin", async () => {
    process.env.ARTIFACT_PUBLIC_URL = "https://sites.acme.internal";
    const res = await publishMdGET(req("https://sites.acme.internal/for-agents.md"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("vary")).toBe("Host"); // body varies by Host when PUBLIC_URL is unset
    const text = await res.text();
    expect(text.startsWith("---\nname: publish-to-artifact-site")).toBe(true); // installable as-is
    expect(text).toContain("https://sites.acme.internal");
    expect(text).not.toContain(DEFAULT_BASE);
  });

  // A hand-built Request carries no Host header unless one is set explicitly, so state it: this is
  // the unconfigured deployment behind a proxy, describing itself from the hostname it was asked on.
  it("derives the base from Host when ARTIFACT_PUBLIC_URL is unset", async () => {
    const res = await publishMdGET(req("https://x/for-agents.md", {
      host: "sites.acme.internal", "x-forwarded-proto": "https",
    }));
    const text = await res.text();
    expect(text).toContain("https://sites.acme.internal");
    expect(text).not.toContain(DEFAULT_BASE);
  });

  it("falls back to the committed default with neither config nor Host", async () => {
    const text = await (await publishMdGET(req("https://x/for-agents.md"))).text();
    expect(text).toContain(DEFAULT_BASE);
  });
});

describe("skill version — the staleness check", () => {
  it("is 12 hex digits of the committed text, deterministic, and changes with the text", () => {
    const v = getSkillVersion();
    expect(v).toMatch(/^[0-9a-f]{12}$/);
    expect(skillVersionOf(getSkillMarkdown())).toBe(v);
    expect(skillVersionOf(getSkillMarkdown() + "\n")).not.toBe(v);
  });
  it("is written into the served frontmatter (any base), never into the committed file, and the base rewrite does not change it", () => {
    expect(getSkillMarkdown()).not.toContain("skill_version:");
    for (const base of [DEFAULT_BASE, "https://sites.acme.internal"]) {
      const served = getSkillForBase(base);
      expect(served).toMatch(new RegExp(`^---\\nname: publish-to-artifact-site\\nskill_version: ${getSkillVersion()}\\n`));
      expect(parseSkill(base).meta.name).toBe("publish-to-artifact-site"); // the parser still finds its keys
    }
  });
  it("/for-agents.md and every API JSON answer carry the same header, and the guide tells agents to compare them", async () => {
    const res = await publishMdGET(new Request("https://x/for-agents.md", { headers: { host: "x" } }));
    expect(res.headers.get(SKILL_VERSION_HEADER)).toBe(getSkillVersion());
    expect(json({ ok: true }).headers.get(SKILL_VERSION_HEADER)).toBe(getSkillVersion());
    expect(json({ error: "no" }, 404).headers.get(SKILL_VERSION_HEADER)).toBe(getSkillVersion());
    const text = getSkillMarkdown();
    expect(text).toContain("X-Artifact-Site-Skill-Version");
    expect(text).toContain("`skill_version`");
  });
});
