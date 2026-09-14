// A presented publish token this server will not honour answers 401 with WHY — `token_unknown`
// (issued elsewhere: tokens are per server) or `token_revoked` — on every open route and on
// /api/auth/me, which is the call the agent skill makes before uploading anything.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, insertPublishToken, revokePublishToken, upsertUser } from "@/lib/db";
import { hashTokenSecret } from "@/lib/publish-token";
import { GET as ME } from "@/app/api/auth/me/route";
import { POST as CREATE } from "@/app/api/sites/route";
import { POST as OPEN_UPLOAD } from "@/app/api/uploads/route";

const dirs: string[] = [];
beforeEach(() => { const d = mkdtempSync(join(tmpdir(), "tok-")); dirs.push(d); process.env.ARTIFACT_DATA_DIR = d; });
afterEach(async () => { await closeDbForTests(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); delete process.env.ARTIFACT_DATA_DIR; });

const B = "http://localhost";
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const body = (r: Response) => r.json() as Promise<{ error?: string; code?: string; user?: unknown }>;

describe("token rejection codes", () => {
  it("/api/auth/me: a good token is the user; an unknown one is 401 token_unknown; a revoked one 401 token_revoked; no token is a plain null", async () => {
    const user = await upsertUser({ authProvider: "t", providerSubject: "u", email: "u@example.net", emailVerified: true });
    await insertPublishToken({ id: hashTokenSecret("ahp_good"), userId: user.id, name: "laptop", createdAt: Date.now() });
    await insertPublishToken({ id: hashTokenSecret("ahp_gone"), userId: user.id, name: "old", createdAt: Date.now() });
    await revokePublishToken(hashTokenSecret("ahp_gone"), user.id);

    const good = await ME(new Request(`${B}/api/auth/me`, { headers: bearer("ahp_good") }));
    expect(good.status).toBe(200);
    expect(((await body(good)).user as { email: string }).email).toBe("u@example.net");

    const unknown = await ME(new Request(`${B}/api/auth/me`, { headers: bearer("ahp_from-another-server") }));
    expect(unknown.status).toBe(401);
    expect(await body(unknown)).toMatchObject({ code: "token_unknown" });
    expect((await body(await ME(new Request(`${B}/api/auth/me`, { headers: bearer("ahp_from-another-server") })))).error).toMatch(/different artifact-site deployment/);

    const revoked = await ME(new Request(`${B}/api/auth/me`, { headers: bearer("ahp_gone") }));
    expect(revoked.status).toBe(401);
    expect(await body(revoked)).toMatchObject({ code: "token_revoked" });

    const anon = await ME(new Request(`${B}/api/auth/me`));
    expect(anon.status).toBe(200);
    expect((await body(anon)).user).toBeNull();
  });

  it("the open write routes refuse with the same codes instead of publishing anonymously", async () => {
    const create = await CREATE(new Request(`${B}/api/sites`, { method: "POST", headers: { ...bearer("ahp_stranger"), "content-type": "application/json" }, body: JSON.stringify({ mode: "paste", html: "<title>x</title>" }) }));
    expect(create.status).toBe(401);
    expect(await body(create)).toMatchObject({ code: "token_unknown" });
    const open = await OPEN_UPLOAD(new Request(`${B}/api/uploads`, { method: "POST", headers: { ...bearer("ahp_stranger"), "content-type": "application/json" }, body: JSON.stringify({ title: "t" }) }));
    expect(open.status).toBe(401);
    expect(await body(open)).toMatchObject({ code: "token_unknown" });
  });
});

describe("the skill matches the server", () => {
  it("tells agents to look in the environment, then tokens/<host>, to verify via /api/auth/me, and what each code means", async () => {
    const { readFileSync } = await import("node:fs");
    const skill = readFileSync("src/content/publish-skill.md", "utf8");
    for (const must of ["ARTIFACT_SITE_TOKEN", "tokens/$HOST", '"$BASE/api/auth/me"', "token_unknown", "token_revoked", "Do NOT delete or overwrite the other server's token"]) {
      expect(skill, must).toContain(must);
    }
  });
});
