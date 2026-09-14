# Product

## In one sentence

A self-hosted "upload to share, edit in place" platform for finished artifacts — drop in the `.html` / `dist/` / multi-page folder / `.zip` / PDF / Office document you got locally or from an agent, immediately get a shareable link, and edit it online. A private Claude Artifacts / OpenAI Sites.

## Users

- Sharers: people who already have a finished front-end artifact (single page, multi-page folder, dist, zip) and want to turn it into an accessible link right away, without touching git, builds or deployment.
- Viewers: can view and demo with nothing but the link, no dependencies to install, no login.
- Re-creators: see a piece of work and want to tweak it in place, or save a completely independent copy and keep working on it.

## Product Purpose

The shortest path from "a finished front end" to "an online piece of work that is shareable, editable in place and version-traceable". Success looks like: drop it in → get a `/s/:slug` link → open it and it just works → make an edit, saved as a new version → save as an independent new site when needed. No git, no build step, no forms — what is uploaded is the finished product.

## Brand Personality

Restrained, trustworthy, efficient, like a mature internal tool: moderate information density, clear state, direct actions. The visual baseline is a warm-paper editorial style: serif display type, paper tones, thin rules, no chrome for its own sake.

## Anti-references

- No marketing-style landing pages, glassmorphism, glowing orbs or excessive animation.
- Do not replace user actions with infrastructure jargon; what the user sees is "upload, share, edit, save as", not git/sandbox/template operations.
- Do not reduce the artifact itself to an attachment of chat or version information — the work comes first.

## Design Principles

1. Work first: the first viewport is the real artifact and the direct actions (share, edit, save as).
2. Shortest path: upload to link, view to edit, edit to share — each completes within one explicit action.
3. Trustworthy versions: every share and fork points at an immutable version snapshot, and can be rolled back.
4. Secure by default: uploaded content always runs in a sandbox iframe (no allow-same-origin) + CSP; viewing is decided by the share link, modification by ownership (account, collaborator, or the creating browser).
5. Invisible infrastructure: storage, Postgres and token details only appear in deployment/administration contexts.

## Accessibility

WCAG 2.1 AA as the baseline: key states are conveyed by text as well as colour, keyboard operation, visible focus and semantic controls are supported, and narrow screens do not overflow horizontally.
