import { afterEach, expect, it, vi } from "vitest";
import { ArtifactSiteClient } from "../src/client.js";
import { run } from "../src/cli.js";

afterEach(() => vi.unstubAllEnvs());
it.each([["official", "set", "--", "-work", "ver_1"], ["official", "clear", "--", "-work"], ["info", "--", "-work"]])("accepts a leading-hyphen slug after the argument delimiter: %j", async (...args) => {
  vi.stubEnv("ARTIFACT_SITE_TOKEN", "test-token");
  const urls: string[] = [];
  const client = new ArtifactSiteClient({ baseUrl: "https://app.example", fetch: (async url => {
    urls.push(String(url)); return Response.json({ officialRevision: 1, officialVersionId: "ver_1", versions: [], currentVersionId: "ver_1" });
  }) as typeof fetch });
  const io = { out: vi.fn(), err: vi.fn(), stdin: async () => "" };
  expect(await run(["--base", "https://app.example", "--json", ...args], io, () => client)).toBe(0);
  expect(io.err).not.toHaveBeenCalled(); expect(urls.length).toBeGreaterThan(0);
  expect(urls.every(url => new URL(url).pathname.startsWith("/api/sites/-work"))).toBe(true);
});
