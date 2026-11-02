# Shared request handlers

HTTP routes and the in-process MCP adapter call these handlers. This layer owns request
validation, authentication, origin checks, rate limits, error mapping, and response shaping.
It delegates business work to the existing site, upload, comment, and sharing services.
Using `Request` and `Response` here preserves the same security and wire contract for both
entry points, without a loopback request or a dependency on Next's route modules.

`src/app/api/**/route.ts` exports handlers and owns any Next route configuration (for example,
`runtime` or `dynamic`). `src/lib/mcp/api.ts` adapts authenticated MCP requests, forwards the
allowed headers and abort signal, and dispatches directly here. Shared HTTP parsing and
error responses live in `src/lib/api-http.ts`.

Publication services call `publication-service.ts`, which coordinates authorized commits
and emits version events only after a successful commit. The metadata facade in `db.ts`
does not call back into publication orchestration. Adapters load shared row mappings, identifiers,
and data contracts directly from `metadata-model.ts`; their `MetadataStore` import is type-only,
so loading an adapter cannot initialize the active-store facade. Request-free publication is guarded test
setup; fixture pointer overrides live explicitly in `publication-fixtures.ts`.

`test/application-boundaries.test.ts` rejects library dependencies on the Next app tree and
publication dependencies from the metadata facade. HTTP/MCP parity and the existing route,
publication, and PostgreSQL suites cover behavior at those boundaries.
