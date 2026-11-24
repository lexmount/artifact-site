#!/usr/bin/env bash
# Upload a complete distribution before making it eligible for GitHub's latest release.
set -euo pipefail

tag="${1:-${GITHUB_REF_NAME:?A release tag is required}}"
manifest=dist-skill/skill-manifest.tsv
# Derive the upload list from the manifest; a glob cannot detect a missing reference asset.
asset_list=$(node --input-type=module - "$tag" <<'NODE'
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
const tag = process.argv[2];
const text = readFileSync('dist-skill/skill-manifest.tsv', 'utf8');
const lines = text.trimEnd().split('\n');
if (text.length > 32768 || lines.shift() !== 'format\t1' || lines.shift() !== `release\t${tag}` || !/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag)) throw new Error('Invalid skill manifest or release tag');
const version = lines.shift()?.split('\t');
if (version?.length !== 2 || version[0] !== 'version' || !/^[a-f0-9]{64}$/.test(version[1])) throw new Error('Invalid manifest version');
const names = new Set();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const rows = lines.map(line => {
  const fields = line.split('\t');
  const [kind, checksum, file] = fields;
  if (fields.length !== 3 || kind !== 'file' || !/^[a-f0-9]{64}$/.test(checksum) || !/^(?:SKILL\.md|topics\.json|references\/[a-z][a-z-]*\.md|scripts\/[a-z][a-z-]*\.(?:sh|mjs))$/.test(file) || names.has(file)) throw new Error('Invalid manifest file');
  names.add(file);
  const asset = 'dist-skill/skill--' + file.replaceAll('/', '--');
  if (!lstatSync(asset).isFile() || hash(readFileSync(asset)) !== checksum) throw new Error('Invalid skill asset: ' + asset);
  return { file, checksum, asset };
});
if (!names.has('SKILL.md') || rows.length > 128) throw new Error('Invalid manifest files');
rows.sort((a, b) => {
  if (a.file < b.file) return -1;
  if (a.file > b.file) return 1;
  return 0;
});
if (hash(rows.map(row => row.file + '\0' + row.checksum + '\n').join('')) !== version[1]) throw new Error('Manifest checksum mismatch');
if (!lstatSync('dist-skill/install.sh').isFile()) throw new Error('Missing installer asset');
process.stdout.write([...rows.map(row => row.asset), 'dist-skill/install.sh'].join('\n'));
NODE
)
files=()
while IFS= read -r file; do files+=("$file"); done <<< "$asset_list"
prerelease=false
if [[ "$tag" == *-* ]]; then prerelease=true; fi

work=$(mktemp -d "${TMPDIR:-/tmp}/artifact-site-release.XXXXXXXX")
trap 'rm -rf "$work"' EXIT
diagnose_starter() {
  local name=$1 starter_id
  if ! starter_id=$(gh api "repos/{owner}/{repo}/releases/tags/$tag" --jq ".assets[] | select(.name == \"$name\" and .state == \"starter\" and .size == 0) | .id"); then
    echo "Could not inspect failed upload state for $name; retry when GitHub is reachable" >&2
    return
  fi
  [[ "$starter_id" =~ ^[1-9][0-9]*$ ]] || return 0
  printf 'Incomplete upload: %s (asset %s, state starter).\n' "$name" "$starter_id" >&2
  printf 'Stop all publishers for %s and wait for uploads to finish.\n' "$tag" >&2
  printf 'Confirm the release is still a draft: gh release view %s --json isDraft\n' "$tag" >&2
  printf 'Recheck the asset name, state and size: gh api "repos/{owner}/{repo}/releases/assets/%s" --jq "{name,state,size}"\n' "$starter_id" >&2
  printf 'Only if it remains an empty starter in that draft, remove that asset: gh api --method DELETE "repos/{owner}/{repo}/releases/assets/%s"\n' "$starter_id" >&2
  echo 'Then rerun the release workflow. If the release is public or the asset is complete, do not delete it; use a new tag for changed content.' >&2
  exit 1
}
verify_asset() {
  local name
  name=$(basename "$1")
  if ! gh release download "$tag" --pattern "$name" --dir "$work"; then
    diagnose_starter "$name"
    echo "Could not download existing skill asset: $name" >&2
    exit 1
  fi
  if ! cmp -s "$1" "$work/$name"; then
    diagnose_starter "$name"
    echo "Existing skill asset differs: $name; use a new release tag" >&2
    exit 1
  fi
}

if ! draft=$(gh release view "$tag" --json isDraft --jq .isDraft); then
  create_options=(--verify-tag --generate-notes --draft)
  if [[ "$tag" == *-* ]]; then
    create_options+=(--prerelease)
  fi
  if gh release create "$tag" "${create_options[@]}"; then
    draft=true
  else
    # Another invocation may have created or published the same tag meanwhile.
    draft=$(gh release view "$tag" --json isDraft --jq .isDraft)
  fi
fi
case "$draft" in
  false)
    for file in "${files[@]}" "$manifest"; do verify_asset "$file"; done
    echo "Skill release $tag is already complete"
    exit 0
    ;;
  true) ;;
  *) echo 'Could not determine release visibility' >&2; exit 1 ;;
esac

# Failed uploads remain a draft, preserving the previous complete latest release.
# The workflow serializes releases by tag. Never clobber even for direct script callers:
# a duplicate asset is acceptable only when its bytes match, regardless of visibility.
for file in "${files[@]}" "$manifest"; do
  if ! gh release upload "$tag" "$file"; then verify_asset "$file"; fi
done
gh release edit "$tag" --draft=false --prerelease="$prerelease"
