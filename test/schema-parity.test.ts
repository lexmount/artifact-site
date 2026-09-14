// Cross-driver schema parity.
//
// The two metadata backends must describe the same tables and columns, and nothing enforces that
// but discipline: a schema change is written twice, in two files, in two dialects. Miss one side
// and everything still compiles, the whole suite still passes (it runs on SQLite), and the defect
// only appears in production — which is the Postgres side, the one the tests never touch.
//
// SQLite is introspected for real: open it, let init() run every CREATE and ALTER, then ask the
// database what it ended up with. Postgres cannot be opened here, so its MIGRATIONS array is read
// as text. That asymmetry is fine — the point is to compare the two declarations against each
// other, and a drift in either direction fails.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDbForTests, getSite } from "@/lib/db";

const dirs: string[] = [];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "ah-parity-"));
  dirs.push(dir);
  process.env.ARTIFACT_DATA_DIR = dir;
});

afterEach(async () => {
  await closeDbForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.ARTIFACT_DATA_DIR;
});

/** Tables → columns, as SQLite actually built them after init(). */
async function sqliteSchema(): Promise<Map<string, Set<string>>> {
  await getSite("trigger-init"); // any call opens the store and runs init()
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(process.env.ARTIFACT_DATA_DIR!, "sites.sqlite"));
  const out = new Map<string, Set<string>>();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  for (const { name } of tables) {
    // The FTS5 virtual table and its shadow tables are SQLite's stand-in for site_texts.tokens
    // (a tsvector column on Postgres); the row table itself is compared like any other.
    if (name.startsWith("site_texts_fts")) continue;
    const cols = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
    out.set(name, new Set(cols.map((c) => c.name)));
  }
  db.close();
  return out;
}

/**
 * Tables → columns, as db-postgres.ts declares them. Reads the whole file, not just MIGRATIONS:
 * `sites` and `versions` predate that array and are created inline in init().
 */
function postgresSchema(): Map<string, Set<string>> {
  const source = readFileSync(join(process.cwd(), "src/lib/db-postgres.ts"), "utf8");
  const out = new Map<string, Set<string>>();

  // Stop the body at the line that closes the paren, so a `REFERENCES users(id)` inside a column
  // definition cannot end the match early.
  for (const m of source.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\s*\)[`;\s]/g)) {
    const [, table, body] = m;
    const cols = new Set<string>();
    for (const line of body.split("\n")) {
      const name = line.trim().match(/^(\w+)\s+(TEXT|BIGINT|INTEGER|BOOLEAN|BIGSERIAL)\b/i)?.[1];
      if (name) cols.add(name);
    }
    out.set(table, cols);
  }
  for (const m of source.matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN IF NOT EXISTS\s+(\w+)/g)) {
    out.get(m[1])?.add(m[2]);
  }
  return out;
}

// Columns that legitimately exist on one side only, each with the reason it is not a drift.
const EXPECTED_DIFFERENCES: Record<string, { pgOnly?: string[]; sqliteOnly?: string[] }> = {
  // BIGSERIAL has no SQLite equivalent; the SQLite backend orders by the implicit rowid instead.
  versions: { pgOnly: ["seq"] },
  // Same reason: audit_log.seq is the Postgres stand-in for the rowid SQLite already has, and both
  // exist only to tiebreak equal created_at values. See the ordering-parity test in audit.test.ts.
  audit_log: { pgOnly: ["seq"] },
  // The search index: a tsvector column on Postgres, the site_texts_fts virtual table on SQLite.
  site_texts: { pgOnly: ["tokens"] },
};

describe("schema parity between the two metadata backends", () => {
  it("declares the same tables on both sides", async () => {
    const sqlite = await sqliteSchema();
    const pg = postgresSchema();
    expect(pg.size).toBeGreaterThan(4); // the parser found something, not an empty map
    expect([...pg.keys()].sort()).toEqual([...sqlite.keys()].sort());
  });

  it("declares the same columns on every table", async () => {
    const sqlite = await sqliteSchema();
    const pg = postgresSchema();
    const drift: string[] = [];

    for (const [table, pgCols] of pg) {
      const sqliteCols = sqlite.get(table);
      if (!sqliteCols) continue; // reported by the table test
      const allowed = EXPECTED_DIFFERENCES[table] ?? {};
      for (const c of pgCols) {
        if (!sqliteCols.has(c) && !(allowed.pgOnly ?? []).includes(c)) drift.push(`${table}.${c} 只在 postgres 有`);
      }
      for (const c of sqliteCols) {
        if (!pgCols.has(c) && !(allowed.sqliteOnly ?? []).includes(c)) drift.push(`${table}.${c} 只在 sqlite 有`);
      }
    }
    expect(drift).toEqual([]);
  });
});
