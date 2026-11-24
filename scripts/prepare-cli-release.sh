#!/usr/bin/env bash
# Pin the CLI distribution to this checkout without replacing an existing release tag.
set -euo pipefail
version=$(node -p "require('./cli/package.json').version")
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ ]] || { echo 'Invalid CLI release version' >&2; exit 1; }
tag="v$version"
head=$(git rev-parse HEAD)
if refs=$(git ls-remote --exit-code origin "refs/tags/$tag" "refs/tags/$tag^{}"); then
  commit=$(awk -v tag="refs/tags/$tag" '$2 == tag {plain=$1} $2 == tag "^{}" {peeled=$1} END {print peeled ? peeled : plain}' <<< "$refs")
  [[ "$commit" == "$head" ]] || { echo "Release tag $tag already points to another commit; run this workflow at that tag or choose a new CLI version" >&2; exit 1; }
else
  status=$?
  [[ "$status" == 2 ]] || exit "$status"
  git push origin "$head:refs/tags/$tag"
fi
printf 'tag=%s\n' "$tag"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then printf 'tag=%s\n' "$tag" >> "$GITHUB_OUTPUT"; fi
