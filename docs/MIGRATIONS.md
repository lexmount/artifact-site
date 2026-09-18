# Database migrations

PostgreSQL is the production metadata store; SQLite is the test equivalent. Existing legacy
bootstrap SQL and RBAC migrations still establish the pre-comments baseline. They are deliberately
not replaced or falsely marked as already applied on existing deployments.

New changes live in numbered modules under `src/lib/migrations/`. `0001-comments.ts` contains
portable additive SQL used by both stores. The runner records ID, SQL checksum and application time
in `schema_migrations`. PostgreSQL runs it inside the existing migration transaction and advisory
lock; SQLite uses its immediate transaction. A failed migration rolls back its DDL and history row.
An already-applied migration is skipped. Changing its SQL checksum fails startup rather than hiding
a divergent production schema.

Add a new numbered module and append it to the runner registry for each subsequent change. Never
edit deployed migration SQL. Use additive, idempotent operations and validate new initialization,
upgrade from the legacy baseline, repeated initialization, constraint enforcement and rollback.
The runner does not automatically downgrade schemas or run destructive rollback SQL.

Run `npm test` for SQLite and `make test-pg` for PostgreSQL. The PostgreSQL CI job includes the real
comment authorization and service suites; it is not limited to schema/unit mocks. Production
startup still runs migrations automatically, so large data backfills require a separately planned
bounded upgrade rather than unbounded work in startup.
