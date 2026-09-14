// Runs once per test file (vitest `setupFiles`) before any test module is imported.
//
// The suite's backends are chosen HERE, not by lib/config peeking at VITEST: sqlite for metadata
// (no external service needed) and the local disk for files (a developer's shell may carry real
// S3 credentials for the gated integration test, and the unit suite must never follow them into a
// live bucket). `??=` keeps an explicit value from the shell — that is how the Postgres
// integration test opts in. lib/config.sqliteAllowed still checks VITEST itself, on purpose: it
// refuses sqlite outside the runner, and an env variable cannot be its own proof.
import { rmSync } from "node:fs";
import path from "node:path";
import { vi } from "vitest";

// The `server-only` marker in lib/db, lib/config, lib/session, ... throws whenever it is imported
// outside a React Server Components build (its default export condition is the throwing one).
// Under vitest every module is plain Node, so stub it out; the marker is a Next build-time check.
vi.mock("server-only", () => ({}));

process.env.ARTIFACT_DATA_DIR = ".data/test";
process.env.ARTIFACT_DB_DRIVER ??= "sqlite";
process.env.ARTIFACT_STORAGE_DRIVER ??= "local";
delete process.env.PUBLISH_API_TOKEN;
delete process.env.CSP_CONNECT_SRC;
// One shared directory for every test file — which is why vitest.config.ts runs files serially.
rmSync(path.join(process.cwd(), ".data/test"), { recursive: true, force: true });
