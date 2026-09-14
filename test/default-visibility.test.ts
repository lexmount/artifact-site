// The default visibility of a NEW site is decided by the deployment: ARTIFACT_DEFAULT_VISIBILITY
// wins when set; otherwise the only distinction is "local development" (no public URL configured
// → public) versus "a real deployment" (→ private). Existing rows are untouched — only the
// creation path is under test here.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, getSite, updateSiteSharing } from "@/lib/db";
import { createSite, forkSite } from "@/lib/sites";

let dir: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ["ARTIFACT_DATA_DIR", "ARTIFACT_PUBLIC_URL", "ARTIFACT_DEFAULT_VISIBILITY"];

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), "ah-vis-"));
  process.env.ARTIFACT_DATA_DIR = dir;
  delete process.env.ARTIFACT_DEFAULT_VISIBILITY;
});
afterEach(async () => {
  await closeDbForTests();
  rmSync(dir, { recursive: true, force: true });
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
});

const made = async () => (await createSite({ mode: "paste", html: "<title>t</title><body>x</body>" }, {})).site;

describe("a new site's default visibility follows the deployment", () => {
  it("a real deployment (public URL configured) → private: nobody can open it until it is shared", async () => {
    process.env.ARTIFACT_PUBLIC_URL = "https://hub.example.com";
    expect((await getSite((await made()).id))!.visibility).toBe("private");
  });

  it("local development (no public URL) → public: otherwise a clean browser sees nothing at all", async () => {
    delete process.env.ARTIFACT_PUBLIC_URL;
    expect((await getSite((await made()).id))!.visibility).toBe("public");
  });

  it("intranet use: an explicit ARTIFACT_DEFAULT_VISIBILITY=public makes the link open for whoever holds it", async () => {
    process.env.ARTIFACT_PUBLIC_URL = "https://hub.intranet.example";
    process.env.ARTIFACT_DEFAULT_VISIBILITY = "public";
    expect((await getSite((await made()).id))!.visibility).toBe("public");
  });

  it("no hostname sniffing: no domain is ever treated as an intranet", async () => {
    for (const url of ["https://artifacts.dev.example.net", "http://10.0.0.5:4300", "https://hub.corp.local"]) {
      process.env.ARTIFACT_PUBLIC_URL = url;
      expect((await getSite((await made()).id))!.visibility, url).toBe("private");
    }
  });

  it("an unrecognised explicit value counts as unset and falls back to the deployment posture", async () => {
    process.env.ARTIFACT_PUBLIC_URL = "https://hub.example.com";
    process.env.ARTIFACT_DEFAULT_VISIBILITY = "yes-please";
    expect((await getSite((await made()).id))!.visibility).toBe("private");
  });
});

describe("a fork is a new site too, and is governed by the same deployment posture", () => {
  // Fork is the third place visibility gets decided, and the only one where the content comes
  // from someone else. It used to do a single thing: copy the visibility over when the source was
  // not public — implying "if the source is public, leave it alone", and "leave it alone" landed
  // on the DB DEFAULT 'public'. On the public internet a fork could therefore mint a public site,
  // and put it in the home-page directory.
  const forkOf = async (visibility: string) => {
    const site = (await createSite({ mode: "paste", html: "<title>源</title><body>x</body>" }, {})).site;
    if (visibility !== (await getSite(site.id))!.visibility) await updateSiteSharing(site.id, visibility as never, "owner");
    const forked = await forkSite(site.slug, {});
    return (await getSite(forked!.site.id))!.visibility;
  };
  const intranet = () => { process.env.ARTIFACT_PUBLIC_URL = "https://hub.intranet.example"; process.env.ARTIFACT_DEFAULT_VISIBILITY = "public"; };

  it("forking a public site on the public internet yields a private copy — a new site is a new site", async () => {
    process.env.ARTIFACT_PUBLIC_URL = "https://hub.example.com";
    expect(await forkOf("public")).toBe("private");
  });

  it("forking a public site on an intranet keeps the copy public", async () => {
    intranet();
    expect(await forkOf("public")).toBe("public");
  });

  it("neither posture launders visibility: an unlisted source does not become a public copy", async () => {
    intranet();
    expect(await forkOf("unlisted")).toBe("unlisted");
  });

  it("the tighter of the two wins: intranet + private source → private copy", async () => {
    intranet();
    expect(await forkOf("private")).toBe("private");
  });
});
