# 0.2.0 upgrade fixture

`pre-rbac-0.2.0.sql` freezes PostgreSQL startup statements from release commit
`19f9c3b` (before PR #157): the base tables and `MIGRATIONS` array in
`src/lib/db-postgres.ts`, its pre-numbered ALTERs, `migrateRbac` in
`src/lib/rbac-store.ts`, and numbered migrations 0001–0006. The old bootstrap's
initial-import and token-retirement branches have both completed on this empty
baseline. Migration checksum values are SHA-256 of each original `statements`
array joined with newlines; the fixture timestamps are fixed at 1.

The snapshot retains original CHECK constraints, foreign keys, indexes and
tracking rows. It does not import current bootstrap code or reconstruct an old
schema by deleting modern migration markers. `pre-rbac-grants.sql` adds historical
users and grants after the old initial import, including stale rows for a removed
member and a disabled account. Each regression gets a private PostgreSQL schema.

`authorization-upgrade.integration.test.ts` runs the full current store startup
against this database and checks grants, metadata, workspace identity, anonymous
credentials, cleanup and revocation across restarts. It is included in
`npm run test:pg:rbac` / `make test-pg`.

For an independent full-runtime check, build the old image from an archive of
`19f9c3b`, build the candidate image, and run:

```sh
bash scripts/test-authorization-upgrade.sh OLD_0_2_0_IMAGE NEW_IMAGE
```

That script boots the old application against disposable PostgreSQL, publishes
an artifact through HTTP and loads only `pre-rbac-grants.sql` (not the frozen
schema). It stops the old binary, boots two new instances sharing the database
and artifact volume, verifies import and HTTP access, revokes a grant and checks
a subsequent restart. All containers, network and volume are removed on exit.
