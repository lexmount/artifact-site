import { afterEach, expect, it } from "vitest";
import { closeDbForTests, createId, createShare, upsertUser } from "@/lib/db";
import { createSite } from "@/lib/sites";
import { mintSession } from "@/lib/session";
import { GET } from "@/app/api/me/share-education/route";

afterEach(() => closeDbForTests());
it("counts history across sites, including expired links, without leaking another user's count", async () => {
  const origin = "https://education.example";
  const owner = await upsertUser({authProvider:"test", providerSubject:createId("subject"), email:"education@example.com", emailVerified:true});
  const other = await upsertUser({authProvider:"test", providerSubject:createId("subject"), email:"other@example.com", emailVerified:true});
  const {cookie} = await mintSession(new Request(origin), owner.id);
  const request = new Request(origin, {headers:{cookie:cookie.split(";")[0]}});
  const {site} = await createSite({mode:"paste", html:"<h1>Education</h1>"}, {ownerId:owner.id});
  const second = await createSite({mode:"paste", html:"<h1>Other site</h1>"}, {ownerId:owner.id});
  const defaults = {passcodeHash:null, label:null, createdAnonId:null, expiresAt:null};
  await createShare({...defaults, id:createId("shr"), siteId:site.id, tokenHash:createId("hash"), policy:"public", createdBy:other.id});
  expect((await (await GET(request)).json()).linksCreated).toBe(0);
  for (let n = 0; n < 3; n++) {
    await createShare({...defaults, id:createId("shr"), siteId:site.id, tokenHash:createId("hash"), policy:"public", createdBy:owner.id, source:"publish"});
  }
  expect((await (await GET(request)).json()).linksCreated).toBe(0);
  for (let n = 1; n <= 4; n++) {
    await createShare({...defaults, id:createId("shr"), siteId:n % 2 ? site.id : second.site.id, tokenHash:createId("hash"), policy:"public", createdBy:owner.id, expiresAt:1});
    expect((await (await GET(request)).json()).linksCreated).toBe(Math.min(n, 3));
  }
  expect((await (await GET(new Request(origin))).json()).linksCreated).toBe(0);
});

it("isolates anonymous identities without exposing their ownership cookies", async () => {
  const history = async (id: string) => (await GET(new Request("https://education.example", {headers:{cookie:`__Host-ah_anon=${id}`}}))).json();
  const first = await history("anon_first");
  expect(first.scope).toMatch(/^anon:[a-f0-9]{64}$/);
  expect(first.scope).not.toContain("anon_first");
  expect((await history("anon_first")).scope).toBe(first.scope);
  expect((await history("anon_second")).scope).not.toBe(first.scope);
});
