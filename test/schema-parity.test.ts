// Cross-driver schema parity.
//
// The two metadata backends must describe the same tables and columns, and nothing enforces that
// but discipline: legacy schema changes were written twice, in two files and dialects. Miss one side
// and everything still compiles, the whole suite still passes (it runs on SQLite), and the defect
// only appears in production — which is the Postgres side, the one the tests never touch.
//
// SQLite is introspected for real: open it, let init() run every CREATE and ALTER, then ask the
// database what it ended up with. Postgres cannot be opened here, so its MIGRATIONS array is read
// and numbered migration modules are read as text. That asymmetry is fine — the point is to compare the two declarations against each
// other, and a drift in either direction fails.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
  const db = new DatabaseSync(
    join(process.env.ARTIFACT_DATA_DIR!, "sites.sqlite"),
  );
  const out = new Map<string, Set<string>>();
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string }[];
  for (const { name } of tables) {
    // The FTS5 virtual table and its shadow tables are SQLite's stand-in for site_texts.tokens
    // (a tsvector column on Postgres); the row table itself is compared like any other.
    if (name.startsWith("site_texts_fts")) continue;
    const cols = db.prepare(`PRAGMA table_info(${name})`).all() as {
      name: string;
    }[];
    out.set(name, new Set(cols.map((c) => c.name)));
  }
  db.close();
  return out;
}

// Require a concrete SQL type so source-code regexes and partial statement fragments
// cannot backtrack an optional IF NOT EXISTS into a fictitious column named IF.
const addedColumnPattern = /ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(?:IF NOT EXISTS\s+)?(\w+)\s+(?:TEXT|BIGINT|INTEGER|BOOLEAN|BIGSERIAL|JSONB)\b/g;

/**
 * Tables → columns from the PostgreSQL bootstrap, RBAC baseline, and numbered migration modules.
 * The registry file also declares schema_migrations. Shared SQL is checked against actual SQLite.
 */
function postgresSchema(): Map<string, Set<string>> {
  const source = [
    "src/lib/db-postgres.ts",
    "src/lib/rbac-store.ts",
    ...readdirSync(join(process.cwd(), "src/lib/migrations"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `src/lib/migrations/${name}`),
  ]
    .map((path) => readFileSync(join(process.cwd(), path), "utf8"))
    .join("\n");
  const out = new Map<string, Set<string>>();

  // Numbered migrations share SQL across drivers and may format a statement on one line.
  // Split only top-level commas: CHECK clauses and composite foreign keys contain nested commas.
  for (const match of source.matchAll(
    /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/g,
  )) {
    const table = match[1];
    let depth = 1,
      quoted = false,
      current = "";
    const definitions: string[] = [];
    for (
      let i = match.index! + match[0].length;
      i < source.length && depth > 0;
      i++
    ) {
      const char = source[i];
      if (char === "'" && source[i - 1] !== "\\") quoted = !quoted;
      if (!quoted) {
        if (char === "(") depth++;
        if (char === ")") depth--;
      }
      if (depth === 0 || (!quoted && depth === 1 && char === ",")) {
        definitions.push(current);
        current = "";
      } else current += char;
    }
    const columns = new Set<string>();
    for (const definition of definitions) {
      const column = definition
        .trim()
        .match(
          /^(\w+)\s+(TEXT|BIGINT|INTEGER|BOOLEAN|BIGSERIAL|JSONB)\b/i,
        )?.[1];
      if (column) columns.add(column);
    }
    out.set(table, columns);
  }
  for (const m of source.matchAll(
    addedColumnPattern,
  )) {
    out.get(m[1])?.add(m[2]);
  }
  // Cleanup migrations remove retired declarations from the effective schema.
  for (const m of source.matchAll(/DROP TABLE IF EXISTS\s+(\w+)/g)) out.delete(m[1]);
  for (const m of source.matchAll(/ALTER TABLE\s+(\w+)\s+DROP COLUMN\s+(\w+)/g)) out.get(m[1])?.delete(m[2]);
  return out;
}

// Columns that legitimately exist on one side only, each with the reason it is not a drift.
const EXPECTED_DIFFERENCES: Record<
  string,
  { pgOnly?: string[]; sqliteOnly?: string[] }
> = {
  // BIGSERIAL has no SQLite equivalent; the SQLite backend orders by the implicit rowid instead.
  versions: { pgOnly: ["seq"] },
  // Same reason: audit_log.seq is the Postgres stand-in for the rowid SQLite already has, and both
  // exist only to tiebreak equal created_at values. See the ordering-parity test in audit.test.ts.
  audit_log: { pgOnly: ["seq"] },
  // The search index: a tsvector column on Postgres, the site_texts_fts virtual table on SQLite.
  site_texts: { pgOnly: ["tokens"] },
};

describe("schema parity between the two metadata backends", () => {
  it("recognizes optional column guards without treating parser source as SQL", () => {
    const source = [
      "ALTER TABLE sample ADD COLUMN plain TEXT",
      "ALTER TABLE sample ADD COLUMN IF NOT EXISTS guarded BIGINT",
      String.raw`/^ALTER TABLE sample ADD COLUMN IF NOT EXISTS (\w+)\s/`,
      'statement.replace("ADD COLUMN IF NOT EXISTS", "ADD COLUMN")',
    ].join("\n");
    expect([...source.matchAll(addedColumnPattern)].map(match=>match.slice(1,3))).toEqual([["sample","plain"],["sample","guarded"]]);
  });

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
        if (!sqliteCols.has(c) && !(allowed.pgOnly ?? []).includes(c))
          drift.push(`${table}.${c} 只在 postgres 有`);
      }
      for (const c of sqliteCols) {
        if (!pgCols.has(c) && !(allowed.sqliteOnly ?? []).includes(c))
          drift.push(`${table}.${c} 只在 sqlite 有`);
      }
    }
    expect(drift).toEqual([]);
  });
});
