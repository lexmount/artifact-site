import { afterEach, expect, it } from "vitest";
import { closeDbForTests, createId, upsertUser } from "@/lib/db";
import { siteAuthorName } from "@/lib/site-author";

afterEach(closeDbForTests);
it("identifies anonymous works", async () => {
  expect(await siteAuthorName({ ownerId: null })).toBeNull();
});
it("does not expose legacy display names, including email and login fallbacks", async () => {
  for (const displayName of ["owner@example.test", "private-login", "Old Name"]) {
    const owner = await upsertUser({ authProvider: "oidc", providerSubject: createId("subject"), displayName });
    expect(await siteAuthorName({ ownerId: owner.id })).toBeUndefined();
  }
});
it("stores only explicit public names and clears stale names when the claim disappears", async () => {
  const input = { authProvider: "oidc", providerSubject: createId("subject"), email: "private@example.test", displayName: "fallback" };
  const owner = await upsertUser({ ...input, publicDisplayName: " Ada " });
  expect(await siteAuthorName({ ownerId: owner.id })).toBe("Ada");
  for (const publicDisplayName of [null, "", "private@example.test", input.providerSubject]) {
    await upsertUser({ ...input, publicDisplayName });
    expect(await siteAuthorName({ ownerId: owner.id })).toBeUndefined();
  }
  expect(await siteAuthorName({ ownerId: "missing" })).toBeUndefined();
});
