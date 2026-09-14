## What

<!-- One paragraph: the behaviour change, as an operator or user would notice it. -->

## Why

<!-- The problem this solves. Link the issue if there is one. -->

## How it was verified

<!-- Tests added or changed; manual checks against a running instance; anything not covered. -->

## Checklist

- [ ] Every commit is signed off (`git commit -s`; `git rebase --signoff main` to fix a branch)
- [ ] Tests cover the change (`npm test`; `make test-pg` if the Postgres store changed; `cd cli && npm test` if the CLI changed)
- [ ] New settings are documented in `.env.example` and checked by `scripts/deploy/doctor.sh` where a mistake would be silent
- [ ] `CHANGELOG.md` has an entry under *Unreleased* if an operator or user would notice
- [ ] Nothing renders uploaded content outside the sandboxed preview, and no path bypasses `safeRelativePath`
- [ ] English in code, comments, and user-facing strings (`t("…")` for UI copy, zh-CN entry added)
