#!/usr/bin/env bash
# The MCP Registry workflow's gate before `mcp-publisher publish`: wait until the CLI package is on
# npm WITH the `mcpName` the registry checks against server.json's `name`.
#
#   scripts/await-cli-on-npm.sh [<cli dir>] [<server.json>]    default: the repository's cli/ and server.json
#
# ATTEMPTS (60) × SLEEP_SECONDS (30) bound the wait; release.yml publishes the package from the same
# tag, so the version normally appears within minutes. A version that is already on npm but carries
# no `mcpName` (or another server's) is not "not there yet": it was published before the package had
# the field, and the registry would refuse the listing. That is the forgotten-bump case — say so at
# once, rather than after the timeout or through the registry's own error.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pkg="$(cd "${1:-$root/cli}" && pwd)/package.json"
server_json="${2:-$root/server.json}"
server_json="$(cd "$(dirname "$server_json")" && pwd)/$(basename "$server_json")"
ATTEMPTS="${ATTEMPTS:-60}"
SLEEP_SECONDS="${SLEEP_SECONDS:-30}"

name="$(PKG="$pkg" node -p "require(process.env.PKG).name")"
version="$(PKG="$pkg" node -p "require(process.env.PKG).version")"
want="$(SERVER_JSON="$server_json" node -p "require(process.env.SERVER_JSON).name")"

for ((i = 1; i <= ATTEMPTS; i++)); do
  if npm view "$name@$version" version >/dev/null 2>&1; then
    # npm prints an empty field for a version that has none and exits 0; a failed lookup is a
    # network hiccup, not an answer, and is retried like a version that is not there yet.
    if got="$(npm view "$name@$version" mcpName 2>/dev/null)"; then
      if [ "$got" = "$want" ]; then
        echo "$name@$version is on npm with mcpName $want"
        exit 0
      fi
      echo "$name@$version is on npm with mcpName '${got:-<none>}', not $want: that version was published before the package carried it. Bump the version in $pkg and tag again." >&2
      exit 1
    fi
  fi
  echo "waiting for $name@$version on npm ($i/$ATTEMPTS)"
  if [ "$i" -lt "$ATTEMPTS" ]; then sleep "$SLEEP_SECONDS"; fi
done
echo "$name@$version did not appear on npm within $((ATTEMPTS * SLEEP_SECONDS)) seconds" >&2
exit 1
