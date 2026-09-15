#!/usr/bin/env bash
# Publish cli/ to npm — the release workflow's publish step, kept in a file so it can be tested.
#
#   scripts/publish-cli.sh [<cli dir>]        default: the repository's cli/
#
# The version comes from the package's package.json and must be a plain semver string. A version
# npm already has is a no-op (re-running a tag, or a version published by hand, must not fail the
# release). A prerelease (anything with a `-`) goes to the `next` dist-tag — npm refuses to publish a
# prerelease without an explicit tag, and `latest` must stay the newest stable release. Publishing
# uses npm's trusted publishing (provenance), so no token is read here.
set -euo pipefail

DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/cli}"
cd "$DIR"

name="$(node -p "require('./package.json').name")"
v="$(node -p "require('./package.json').version")"
if ! [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "$DIR/package.json version is not a semver string: $v" >&2
  exit 1
fi

if npm view "$name@$v" version >/dev/null 2>&1; then
  echo "$name@$v is already on npm; nothing to publish"
  exit 0
fi

# `${tag[@]+"${tag[@]}"}` rather than "${tag[@]}": an empty array trips `set -u` on bash 3.2 (macOS).
tag=()
if [[ "$v" == *-* ]]; then tag=(--tag next); fi
echo "publishing $name@$v${tag[1]:+ (dist-tag ${tag[1]})}"
npm publish --provenance --access public ${tag[@]+"${tag[@]}"}
