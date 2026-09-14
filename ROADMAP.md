# Roadmap

What is planned, in rough order. Each item is a self-contained pull request or two; none of them
changes the deployment contract (one image, Postgres, optional S3) unless it says so. Dates are
deliberately absent — the order is the commitment. Open an issue to argue for a reordering.

## Next

### Semantic search (hybrid, optional)

Today's search is a lexical index: every word of the query must occur, results are ranked by term
frequency with the title weighted up, and there is no notion of meaning — "budget overrun" does
not find a page titled "quota alerts". The plan is a hybrid search that stays optional:

- **Chunk and embed** the extracted text of each site's current version (the same `site_texts`
  pipeline: after the response, backfilled by the maintenance tick) through a configurable
  embedding endpoint (`ARTIFACT_EMBEDDING_URL` / model / key — OpenAI-compatible, so a local
  server works too). Vectors live in Postgres via `pgvector`, which the reference image already
  ships; SQLite (tests) falls back to lexical only.
- **Query** runs both retrievers — lexical (current) and vector (cosine) — and fuses them with
  reciprocal rank fusion. Results keep today's shape (`slug`, `title`, `url`, `snippet`) plus a
  `matched: "text" | "meaning" | "both"` hint so an agent knows why it got a hit.
- **Nothing configured = today's behaviour.** A self-hoster with no model gets exactly the lexical
  search; the console shows whether embeddings are on and how far the backfill is.
- **Summaries ride the same model.** With an embedding endpoint (or a chat endpoint next to it) the
  index can also hold a one-paragraph summary per site, returned as `summary` in search results so
  an agent can decide what to read before reading it — the layered-context idea from tools like
  OpenViking, without a separate store.
- Scope: `lib/site-text.ts` gains a `chunks`/`embeddings` table and an embedding client; `search.ts`
  gains the fusion; CLI/MCP unchanged except the new fields. Estimated 3–5 days plus the operating
  cost of the model endpoint.

### Comments on sites

Readers of a site — the same people a share link admits — can leave comments: on the site as a
whole and, where the artifact is a page, anchored to a selection (the selection bridge that the
assistant already uses reports text and a CSS path, which is exactly what an anchor needs).

- **Model**: `comments` (site, version at the time, author or anonymous marker, body, anchor,
  resolved-by/at, created/edited); replies are comments with a parent. Threads, not a tree.
- **Who may**: reading rights are commenting rights, per share link (`allowComments` on a share,
  default on for signed-in readers, off for passcode/public links until the owner enables it).
  Owners and collaborators can resolve and delete; authors can edit their own for a while.
- **Where they show**: a panel in the viewer bar ("More" menu → Comments), a count on the site
  card, and the owner's activity feed. Anchored comments highlight their selection when hovered.
- **For agents**: `GET /api/sites/:slug/comments` (and the MCP tool `artifact_site_comments`) so an
  agent asked to "address the feedback on the report" can read it — and `POST` to reply, so the
  loop closes in the same place people are looking. Comments are searchable through the same
  text index once they exist.
- **Notifications** are out of scope for the first cut; the owner's activity feed is the signal.
- Estimated 4–6 days including the viewer UI and i18n.

### Server-side search on the home page

The home page's search box filters titles in the browser. Point it at `/api/search` so it finds
sites by content too, with the same scope rules. Small.

## Later

- **Extraction as a worker.** Text extraction runs after the response in the web process today,
  bounded and gated; a deployment that wants it out of the serving process entirely needs a switch
  (`ARTIFACT_TEXT_INDEX=off` in the web process), a worklist claim (`SKIP LOCKED`) so several
  workers do not repeat each other, and a policy for reads of un-indexed sites. About 200 lines.
- **GitHub sign-in** next to Google/OIDC (an adapter over the existing OIDC flow).
- **A separate content origin** (`ARTIFACT_CONTENT_URL`) so hosted pages are served from a domain
  that shares no cookies with the platform — the sandbox already isolates them; this closes the
  remaining browser-level edge cases.
- **Tags** on sites, and search by tag.
- **Tenants**: the console's settings table is already keyed by scope for this; the rest (users,
  quotas and sites belonging to a tenant) is a larger change and comes when there is a customer
  for it.

## Done recently

See [CHANGELOG.md](CHANGELOG.md): full-text search and plain-text read for agents, console
settings, quotas and anonymous-site expiry, the administration console, per-server publish
tokens, account folders, the CLI and MCP server.
