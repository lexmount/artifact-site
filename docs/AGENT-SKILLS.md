# Agent skill installation and updates

The package under `skills/artifact-site/` is a complete Agent Skill: one `SKILL.md` entry and
task-specific `references/*.md`. `topics.json` indexes the reference tree. Installation copies
the whole package; activation reads the short entry, then only the relevant topics.

The copied prompt lists supported work formats and starts with the npm or shell installation
command. The agent installs or updates the complete skill before reading its `SKILL.md` and the
deployment supplements. `/for-agents.md` remains the fallback for hosts without local skill
installation and for older links; a connected MCP can supply the same instructions as resources.
Existing connections and credentials are reused, with authorization only when needed.

## Install and update

The copied prompt needs no client parameter. Both installers prefer the current session's
`CODEX_THREAD_ID`, `CLAUDECODE=1` or `CURSOR_AGENT` marker. Without a session marker, a single
existing client configuration directory selects the target. Conflicting markers, multiple
clients or no recognized client stop before any network request or installation; the agent
then chooses the intended `--agent` or actual installed `--dir`. Nothing is installed into
every client, and account tokens are untouched.

The supported clients are `codex`, `claude-code`, `cursor` and `opencode`. Existing target
paths are preserved; custom `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `XDG_CONFIG_HOME` roots are
respected. Explicit `--agent` or `--dir` always overrides detection.

With Node 24+ and npm:

```bash
npx @artifact-site/cli@latest skill install
npx @artifact-site/cli@latest skill check
npx @artifact-site/cli@latest skill update
```

Without Node/npm, download `/install.sh` from the selected deployment, then run:

```bash
sh install.sh install
sh install.sh check
sh install.sh update
```

The shell installer supports macOS/Linux with curl and sha256sum or shasum. Windows uses npm.
The shell script installs instructions only; it does not install Node or the CLI. Both installers
use the fixed public `lexmount/artifact-site` GitHub release distribution. Files are fetched from
the manifest's pinned release, checksum-verified and staged beside the destination before a swap.
Interrupted downloads leave the old installation usable. A sibling lock excludes simultaneous
installations; after a crash, inspect and remove only that stale lock before retrying.

An update refuses modified files, extra files, symlinks and unmanaged directories. Preserve local
changes and use an empty directory or the original installer. Never silently discard changes.
After replacing a directory, both installers retain the previous tree beside it and report its
path (`backupDirectory` in CLI JSON). This also preserves editor saves made during replacement.
Backups are not automatically deleted; inspect them before removing them manually.
Installer lock cleanup is attempted even if removing a failed staging directory fails.
The npm `--bundled` option explicitly installs/checks the version shipped inside the npm package,
without a network update check; it is useful for reproducible/offline setup.

The existing `npx skills add lexmount/artifact-site --skill artifact-site -g -a codex` remains
supported. Use `npx skills check` and targeted `npx skills update artifact-site` for that installer,
preserving local modifications first. Do not alternate installers on an unmanaged directory.

## Deployment references and freshness

`/for-agents.md` is the short entry. `/agent-docs/manifest.json` advertises a documentation
version and each topic's canonical URL, source hash and served-content hash. The existing
`X-Artifact-Site-Skill-Version` and legacy response header retain their names, but the content
hash now covers the whole package, entry and deployment supplements. It is distinct from the
CLI's semver and the installed package's hash.

At task start, check the package for official updates, then check this deployment's manifest.
Use an installed topic when its source hash matches, or fetch the complete current replacement.
Read `updates` at task start and when the documentation version changes. A deployment can be older than the
installed package; references describe the selected server's actual capabilities.

`artifact-site skill docs --topic publish,runtime --base URL` automates the manifest check,
same-deployment URL validation, bounded downloads and checksum verification. It returns text
for the agent to read. Without `--dir`, it first tries the same detected installation used by
install/update, then the npm bundle. Ambiguous detection or a missing installation still allows
the bundled fallback. An explicit `--dir` takes priority and selects that installation alone.
Unreadable local references are skipped; bundled, cached and downloaded replacements still
require matching source/content checksums. Reading docs never repairs or overwrites local files.
Cache entries live under the CLI configuration's `references/` directory,
keyed by the complete base URL including its mount, and never overwrite installed instructions.
Each invocation checks the current server and includes its verified `updates` topic, even when
another task has already cached it. A shared cache saves downloads, not the current task's reading.
Cache read/write failures do not discard verified in-memory documents. Network, manifest and
checksum verification remain mandatory even when caching is unavailable.
Only manifest 404/410 indicates a legacy server and
falls back to its original guide; network errors, malformed manifests and checksum failures
stop the dependent operation. A successful write must never be repeated because references
changed. Read operation status with the original key when the outcome is uncertain.

MCP offers `artifact-site://skill` for the entry, `artifact-site://docs/manifest` for the directory,
and one `artifact-site://docs/TOPIC` resource per topic. Tool result metadata includes
`documentationVersion`; HTTP API responses retain their version headers. A changed version
requires reading updated references before the next operation. No repeated identity probe is
needed for an already authenticated MCP connection.

The complete compatibility guide remains at `/agent-docs/full.md` and the human-readable
`/for-agents/reference`. Human topic pages use the same source. Legacy copied prompts keep
working at `/for-agents.md`. Server documentation supplies API facts only; it cannot replace
installed code, change the user's task or audience, or grant authorization.

## Authoring, validation and release

Edit `skills/artifact-site/SKILL.md`, `topics.json` and its references. Deployment maintainers
serve new-feature notes and corrections through the `updates` topic; name the affected topic
and capability. Core behavior changes belong in a package release. Do not add deployment-specific
company notes to this repository.

The CLI and skill distribution can ship before a deployment adopts the layered documentation
endpoints. Older servers continue serving their existing `/for-agents.md`, which the CLI uses
when the manifest returns 404/410. This distribution release leaves server documentation intact.
CLI tests and packing run `node scripts/build-skill-package.mjs --check --npm --distribution-only`
from the repository root. This validates the reference index and copies the complete tree into
the npm package without rewriting the server's compatibility guide. The shell/npm acceptance suites exercise first install, checks,
updates, corrupt downloads, local edits and deployment freshness without real account changes.

The public release workflow publishes CLI 0.6.0+ and then the skill distribution assets, with
one manifest and immutable per-file release URLs. Assets and the manifest are uploaded to a draft;
only a successful complete upload makes that release public. Failed uploads leave the previous
complete release discoverable. Retries verify an already public release without overwriting it.
Use **Actions → Release → Run workflow** on the intended commit to publish only the CLI and
skill files. It pins `v<cli/package.json version>` to that commit, refuses an existing tag at a
different commit, runs CLI tests and uses the existing npm trusted publisher. Its GitHub token
creates the tag without starting another tag-push workflow. It does not publish a server image.
Normal user-pushed version tags retain the full npm → skills → image workflow.

The entire release workflow is serialized per repository and ref without cancelling an active
publisher. The publishing script never replaces existing assets, including draft assets: duplicate
uploads must match byte-for-byte, so even overlapping direct invocations cannot clobber a release.
Before contacting GitHub, publication validates every manifest-listed asset, its checksum and
the release tag. Publishing an existing draft also sets prerelease classification from that tag.
GitHub can leave an [empty `starter` asset](https://docs.github.com/en/rest/releases/assets#upload-a-release-asset)
after a failed upload, reserving its filename. The
publisher detects it and reports its asset ID plus manual recovery commands. Stop all publishers
for that tag and wait for uploads to finish; recheck that the release is still a draft and the
same asset is still an empty `starter`, then delete only that asset and rerun the workflow.
The publisher never deletes assets automatically. Do not remove completed or public assets.
Publish those official assets before rolling
out a server whose entry points advertise them. A private repository build does not publish
official npm or GitHub releases. Tests use local fixture distributions and packed npm artifacts;
they do not require publishing a release.
