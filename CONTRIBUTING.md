# Contributing

Thanks for helping. This page is the short version of how the project works; the code comments
carry the long version.

## Running it locally

```bash
npm install
make dev          # starts a throwaway Postgres in Docker, then `next dev` on http://127.0.0.1:4300
npm test          # unit tests — no external services needed (SQLite is the test-only backend)
npm run typecheck
npm run lint
make test-pg      # the Postgres integration suite against a disposable container
(cd cli && npm ci && npm test)   # the CLI package has its own suite
# Final image + disposable Postgres + browser/PDF read/search checks (Chrome required):
docker build -t artifact-site:ci .
E2E_CHROME=/path/to/chrome bash scripts/test-image.sh artifact-site:ci
```

`npm run dev` alone also works if you export `ARTIFACT_DATABASE_URL` yourself.

## Ground rules

- **English in code, comments, commit messages, and docs.** User-facing strings go through
  `t("English text")` (see `src/lib/i18n.ts`); add the Chinese translation to the matching file
  under `src/locales/zh-CN/`. Missing translations fall back to English, never to a blank.
- **Tests first for behaviour changes.** A fix for a bug comes with a test that fails without it.
  If you touch the Postgres store, run `make test-pg`; schema changes must be idempotent
  (`CREATE … IF NOT EXISTS`, additive `ALTER`) because replicas migrate concurrently under an
  advisory lock.
- **Untrusted content stays untrusted.** Anything that renders uploaded HTML outside the sandboxed
  iframe, relaxes the preview CSP, or accepts a path without going through `safeRelativePath`
  needs a security-focused review. See `SECURITY.md` for the threat model.
- **Configuration is explicit.** New settings get: a getter in `src/lib/config.ts`, a line in
  `.env.example`, a check in `scripts/deploy/doctor.sh` if misconfiguration would be silent, and
  a mention in `SELFHOST.md`.
- **No new metadata backend.** Postgres is the only production store; SQLite exists for the test
  suite only and is refused at runtime.

## Sign your work

Every commit needs a `Signed-off-by:` trailer with your name and email:

```bash
git commit -s -m "fix: …"
```

That line is the [Developer Certificate of Origin](https://developercertificate.org): you certify
that you wrote the change, or have the right to submit it, under this project's licenses —
Apache-2.0 or MIT, at the user's option (see LICENSE-APACHE and LICENSE-MIT). Contributions
are accepted under both. There is nothing to register and nothing to sign elsewhere; CI checks the trailer on
every commit of a pull request. Forgot it on a branch? `git rebase --signoff origin/HEAD` (the default branch) adds it to
every commit at once.

## Pull requests

- One topic per PR. Small is fine; drive-by refactors go in their own PR.
- Keep commit titles under 72 characters, in English. Put the story in the PR description.
- CI must be green: typecheck, lint, unit tests, Postgres integration tests, CLI, Docker build, DCO.
- Update `CHANGELOG.md` under *Unreleased* for anything an operator or user would notice.

## Releasing

The server and CLI require Node 24 or newer. CI also installs the packed CLI on Node 24 and
tests the built container, including its license files and the server-side PDF worker.

Maintainers tag `vX.Y.Z` on `main`. The release workflow builds a multi-arch image and pushes it
to `ghcr.io/lexmount/artifact-site`. Move the *Unreleased* section of `CHANGELOG.md` under the new
version in the same commit as the tag.
