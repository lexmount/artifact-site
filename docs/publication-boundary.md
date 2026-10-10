# Publication integration boundary

`src/lib/publication-policy.ts` owns the deployment integration contract for
version publication and reader projections. The shared implementation publishes
immediately. It introduces no configuration, database migration, background process,
or additional user workflow.

- `commitVersion` runs after the immutable version and current pointer are written,
  inside the existing authorization transaction. Its default implementation also
  applies a requested official designation in that transaction. Throwing rolls back
  the version, pointer and audit. Only database work belongs here, never model calls,
  external requests or storage I/O.
- `readerSite` projects a request-local site for reader bytes and metadata. It must
  not mutate the stored editable pointer. Explicit fixed-version selections continue
  to use the existing authorization and version checks.
- `externalSite` projects the target of an independent share, without inheriting an
  owner's private credentials.
- `allowsVersion` and `allowsRequestVersion` add publication constraints. Returning
  true does not authorize access: the normal tenant, identity, role, share, receipt,
  preview-key and path checks still apply.

Deployments can replace this module's implementation while retaining its typed
contract and shared call sites. This is a source integration boundary, not a runtime
plugin loader. Additional deployment behavior, persistence and interfaces should
remain in separate changes from shared features. An implementation with additional
publication restrictions must cover version lists, scoped preview keys, metadata,
search, receipts and event streams as well as the main viewer; these hooks alone do
not claim to enforce a deployment's complete policy.

`test/publication-policy.test.ts` covers default publication, unchanged private
access, reader projection, explicit-version constraints and atomic rollback. Existing
sharing, authorization, official-version and viewer suites remain part of acceptance.
