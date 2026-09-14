# Notes for AI coding agents

Read `CONTRIBUTING.md` first; it is the contract. The points below are the ones agents most often
get wrong.

- **Sign every commit: `git commit -s`.** The `Signed-off-by:` trailer (DCO) is checked by CI on
  every pull request; a missing one blocks the merge.
- **Commit titles: English, under 72 characters, no essay in the body.** Implementation notes,
  verification output, and review replies belong in the PR description, not the commit message.
  Check with `npm run check:commit-msg <base>` before merging.
- **User-facing strings go through `t("English")`.** Add the zh-CN entry in the area's file under
  `src/locales/zh-CN/`. Server-side and API error messages are plain English.
- **Do not add a metadata backend or a storage backend without an integration test** gated on
  an environment variable (see `test/*.integration.test.ts`).
- **Never render uploaded content outside the sandboxed preview iframe**, and never relax the
  preview CSP. Route every user-supplied path through `safeRelativePath`.
- **Tests:** `npm test` (unit, no services); `make test-pg` (Postgres);
  `VIEWER_E2E_URL=… npx vitest run test/document-viewer.e2e.test.ts` and
  `GOTENBERG_URL=… npx vitest run test/document-convert.integration.test.ts` (gated).
- **Hosted-artifact runtime limits** (sandbox, paths, API reachability) are documented for agents
  in `src/content/publish-skill.md`, served at `/for-agents.md`.
- Notes about any one company's own deployment do not belong in this repository; keep them with
  that deployment.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
