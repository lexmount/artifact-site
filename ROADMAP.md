# Roadmap

What is planned, in rough order. Each item is a self-contained pull request or two; none of them
changes the deployment contract (one image, Postgres, optional S3) unless it says so. Dates are
deliberately absent — the order is the commitment. Open an issue to argue for a reordering.

The theme of the next stretch: 0.2.0 made the platform wide — publishing, versions, sharing, RBAC,
comments, search, MCP. What follows closes the loop that none of the hosted alternatives have —
**an agent publishes, people review, the agent addresses the feedback** — and makes published
work easier to find and to show.

## Next

### Notifications and webhooks

Comments exist; nobody hears about them. First cut: the site owner and thread participants get an
email (via the existing OIDC identity's address) when a thread is opened, replied to or resolved,
and when a site they own or follow gets a new version — batched, at most one message per site per
hour. Then a per-site **webhook** (`POST` with a signed JSON body for `comment.created`,
`comment.resolved`, `version.published`, `official.changed`) so a chat bot or an agent runner can
react. The webhook is what lets "a comment arrives → an agent wakes up and fixes it" happen without
polling. Delivery is at-least-once with retries and a visible log in site settings.

### Server-side search on the home page

The home and Explore search boxes filter titles in the browser. Point them at `/api/search` so they
find sites by content too, with the same scope rules. Small.

### Link previews and thumbnails

A share link pasted into Slack, Feishu or a wiki renders as a bare title today: the viewer sets
`og:title` but no image. Capture a screenshot of the current version after publish (Gotenberg
already ships Chromium; a deployment without Gotenberg gets a generated typographic card instead),
store it next to the version, serve it as `og:image`, and use it on site cards so Explore and My
sites become a wall of work rather than a list of names. Screenshots run after the response, like
text extraction, and are never in the publish path.

### Compare two versions

Official versions and exact-version review exist; comparing them means switching back and forth.
Add a side-by-side view of any two versions of a site — rendered previews in sync, plus a text
diff of the extracted content — reachable from version history and from a comment's "addressed
in vN" link. Reviewing what an agent changed becomes one screen.

### GitHub and Google sign-in

An adapter over the existing OIDC flow for the two providers most self-hosters and every visitor
to the hosted demo already have. Today the demo only accepts the operator's own identity provider,
so a visitor who clicks *Sign in* stops there. Deployments keep their OIDC provider; these are
additional buttons, off unless configured.

## Then

### Feedback for agents, in one call

Per-thread agent context exists (`/api/sites/:slug/comments/:thread/agent-context`). Add the
site-level view an agent actually asks for — `artifact_site_feedback` in MCP and `GET
/api/sites/:slug/feedback`: every unresolved thread with its anchor, quoted text, version and
replies, in one authorized response — and let `artifact_site_update` name the threads it
addresses so they are marked *addressed in vN* and link to the compare view. This is the story
the README should open with.

### Tags and a team showcase

Sites accumulate; folders are one dimension. Add free-form tags on sites (owner-editable, agent-
settable at publish), filter and search by tag, and a tenant-level **showcase** page that lists
only official versions, optionally public, so a team can hand out one URL for "what we have
built". Tags ride the existing text index.

### Analytics for owners

Total views exist. Give owners the breakdown the count implies: per share link, per version, per
day, unique readers versus opens, and where readers came from (referrer host). Same retention
switch as view details today; nothing is collected that is not already recorded.

### Embedding

An `<iframe>` snippet per site (and oEmbed discovery on `/s/:slug`) that honours the site's share
policy, so a published page can sit inside Notion, a Feishu document or an internal wiki. The
embed serves the sandboxed viewer, never the raw files.

## Later

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
  an agent can decide what to read before reading it.
- Scope: `lib/site-text.ts` gains a `chunks`/`embeddings` table and an embedding client; `search.ts`
  gains the fusion; CLI/MCP unchanged except the new fields. Estimated 3–5 days plus the operating
  cost of the model endpoint. The real customer is agents reading at volume; this waits until they do.

### A small runtime for artifacts — decision pending

Hosted alternatives let an artifact call a model and keep state. [PRODUCT.md](PRODUCT.md) says
artifact-site hosts finished files and runs no backends, and that line is worth keeping. The
candidate middle ground is two narrow capabilities, off by default and scoped to one site: a
key–value store (`window.artifactSite.kv`) and form submissions collected into the owner's site
settings. Enough for a poll, a sign-up sheet or a status board; not a platform. Decide before
building.

### A separate content origin

`ARTIFACT_CONTENT_URL`, so hosted pages are served from a domain that shares no cookies with the
platform — the sandbox already isolates them; this closes the remaining browser-level edge cases.
Required before the first deployment that serves untrusted publishers to the public internet.

### Extraction as a worker

Text extraction (and, above, screenshots) run after the response in the web process today, bounded
and gated; a deployment that wants them out of the serving process entirely needs a switch
(`ARTIFACT_TEXT_INDEX=off` in the web process), a worklist claim (`SKIP LOCKED`) so several
workers do not repeat each other, and a policy for reads of un-indexed sites. About 200 lines.

### Notification inbox pagination

The inbox already supports cursor-based Load more. Follow-up work should validate long inboxes,
filter changes, and concurrent arrivals, and refine the loading/retry experience without moving
the reader's current position. A numbered pagination UI is not part of the current UX changes.

## Done

See [CHANGELOG.md](CHANGELOG.md).

- **0.2.0**: comments on sites — anchored to a selection in HTML, image and PDF artifacts, threads
  with replies, reactions and read progress, exact-version review, per-thread agent context;
  tenant-scoped RBAC with tenant/site administrators and version-bound share grants; official
  versions; recoverable publishing for large trees; OAuth sign-in for MCP clients; share link
  management; opt-in GA4; the agent skill and the multilingual README.
- **0.1.0**: full-text search and plain-text read for agents, remote MCP, the agent guide, console
  settings, quotas and anonymous-site expiry, the administration console, per-server publish
  tokens, account folders, the CLI, the interface redesign.
