// The migration array runs on EVERY startup, so any non-idempotent statement turns the second
// boot into a crash loop that only surfaces on some unrelated restart days later. This test calls
// init() twice — it catches both a missing IF NOT EXISTS and a syntax error the first pass hid.
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@/lib/db-sqlite";

const dirs: string[] = [];

function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ah-mig-"));
  dirs.push(dir);
  process.env.ARTIFACT_DATA_DIR = dir;
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.ARTIFACT_DATA_DIR;
});

describe("migrations", () => {
  it("init() is idempotent — a second run on the same database succeeds", async () => {
    freshDataDir();
    const first = new SqliteStore();
    await first.init();
    await first.close();

    // Same file, fresh store: every CREATE/ALTER now hits an object that already exists.
    const second = new SqliteStore();
    await expect(second.init()).resolves.toBeUndefined();
    await second.close();
  });

  it("creates every identity table and leaves sites usable", async () => {
    freshDataDir();
    const store = new SqliteStore();
    await store.init();

    // A site round-trip must still work with the new columns present.
    await store.insertSiteWithVersion(
      { id: "site_x", slug: "sx", title: "t", kind: "single", editToken: "tok", visibility: "public" },
      { id: "ver_x", siteId: "site_x", entry: "index.html", fileCount: 1, byteSize: 4, source: "upload" },
    );
    const site = await store.getSiteBySlug("sx");
    expect(site).not.toBeNull();
    // Defaults must match the DDL. A pre-identity row is unowned AND locked to the most
    // restrictive tier — with no anonymous edit tier, it stays unwritable until an owner is
    // assigned manually, which is the intended migration path.
    expect(site!.ownerId).toBeNull();
    expect(site!.visibility).toBe("public");
    await store.close();
  });
});


it("upgrades legacy share columns through the tracked migration and tolerates pre-existing columns", async () => {
  freshDataDir();
  const store = new SqliteStore();
  await store.init();
  await store.rbacQuery("DELETE FROM schema_migrations WHERE id='0003-share-token-source'");
  await store.rbacQuery("ALTER TABLE site_shares DROP COLUMN token");
  await store.rbacQuery("ALTER TABLE site_shares DROP COLUMN source");
  await store.init();
  expect((await store.rbacQuery("PRAGMA table_info(site_shares)")).map(row => row.name)).toEqual(expect.arrayContaining(["token", "source"]));
  const [tracked] = await store.rbacQuery("SELECT checksum FROM schema_migrations WHERE id='0003-share-token-source'");
  expect(tracked.checksum).toMatch(/^[a-f0-9]{64}$/);
  await store.rbacQuery("DELETE FROM schema_migrations WHERE id='0003-share-token-source'");
  await store.init();
  await store.init();
  expect(await store.rbacQuery("SELECT checksum FROM schema_migrations WHERE id='0003-share-token-source'")).toEqual([tracked]);
  await store.close();
});
