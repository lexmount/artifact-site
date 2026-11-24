#!/bin/sh
# Install the complete skill without Node/npm. Account credentials are never read or changed.
set -eu
umask 077
fail() { printf '%s\n' "$*" >&2; exit 1; }
usage() { printf '%s\n' 'Usage: sh install.sh [install|update|check] [--agent NAME | --dir DIRECTORY]' 'Automatically selects the current agent; explicit options override detection.'; }
action=install
agent=
destination=
case "${1:-}" in install|update|check) action=$1; shift ;; esac
while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent) [ "$#" -ge 2 ] || fail 'Missing agent'; agent=$2; shift 2 ;;
    --dir) [ "$#" -ge 2 ] || fail 'Missing directory'; destination=$2; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail 'Unknown argument' ;;
  esac
done
if [ -z "$destination" ]; then
  codex_root="${CODEX_HOME:-$HOME/.codex}"
  claude_root="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  cursor_root="$HOME/.cursor"
  opencode_root="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
  if [ -z "$agent" ]; then
    count=0
    candidate=
    consider() { candidate=$1; count=$((count + 1)); }
    [ -z "${CODEX_THREAD_ID:-}" ] || consider codex
    [ "${CLAUDECODE:-}" != 1 ] || consider claude-code
    [ -z "${CURSOR_AGENT:-}" ] || consider cursor
    [ "$count" -le 1 ] || fail 'Multiple agent sessions detected; use --agent or --dir for the intended skill directory'
    if [ "$count" -eq 0 ]; then
      [ ! -d "$codex_root" ] || consider codex
      [ ! -d "$claude_root" ] || consider claude-code
      [ ! -d "$cursor_root" ] || consider cursor
      [ ! -d "$opencode_root" ] || consider opencode
    fi
    [ "$count" -eq 1 ] || fail 'Could not determine one current agent; use --agent or --dir for the intended skill directory'
    agent=$candidate
  fi
  case "$agent" in
    codex) destination="$codex_root/skills/artifact-site" ;;
    claude-code) destination="$claude_root/skills/artifact-site" ;;
    cursor) destination="$cursor_root/skills/artifact-site" ;;
    opencode) destination="$opencode_root/skills/artifact-site" ;;
    *) usage >&2; fail 'Choose the current agent with --agent codex|claude-code|cursor|opencode, or supply --dir' ;;
  esac
fi
case "$destination" in /*) ;; *) destination="$PWD/$destination" ;; esac
[ "$destination" != / ] || fail 'A skill directory is required'
case "$destination" in */../*|*/..|*/./*|*/.|*/) fail 'Use a normalized directory without dot segments or a trailing slash' ;; esac
command -v curl >/dev/null 2>&1 || fail 'curl is required'
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$1" | awk '{print $1}'; }
else fail 'sha256sum or shasum is required'; fi
releases=https://github.com/lexmount/artifact-site/releases
work=$(mktemp -d "${TMPDIR:-/tmp}/artifact-site-install.XXXXXXXX")
staging=
backup=
locked=
cleanup() {
  if [ -n "$backup" ] && [ ! -e "$destination" ] && [ -d "$backup" ]; then mv "$backup" "$destination" || printf 'Previous skill remains at %s\n' "$backup" >&2; fi
  [ -z "$staging" ] || rm -rf "$staging"
  [ -z "$locked" ] || rmdir "$locked" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup 0
trap 'exit 130' INT
trap 'exit 143' TERM HUP
fetch() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 60 --max-filesize 2097152 "$1" --output "$2"
  [ "$(wc -c < "$2")" -le 2097152 ] || fail 'Download exceeds size limit'
}
validate() {
  [ "$(wc -c < "$1")" -le 32768 ] || fail 'Skill manifest is too large'
  awk -F '\t' '
    NR==1 {if(NF!=2 || $1!="format" || $2!="1") exit 1; next}
    NR==2 {if(NF!=2 || $1!="release" || $2 !~ /^v[0-9]+[.][0-9]+[.][0-9]+(-[a-zA-Z0-9.-]+)?$/) exit 1; next}
    NR==3 {if(NF!=2 || $1!="version" || length($2)!=64 || $2 ~ /[^a-f0-9]/) exit 1; next}
    {if(NF!=3 || $1!="file" || length($2)!=64 || $2 ~ /[^a-f0-9]/ || $3 !~ /^(SKILL[.]md|topics[.]json|references\/[a-z][a-z-]*[.]md|scripts\/[a-z][a-z-]*[.](sh|mjs))$/ || seen[$3]++) exit 1; if($3=="SKILL.md") main=1; count++}
    END {if(!main || count>128) exit 1}
  ' "$1" || fail 'Invalid skill manifest'
  awk -F '\t' '$1=="file" {print $3 "\t" $2}' "$1" | LC_ALL=C sort > "$work/rows"
  : > "$work/hash-input"
  tab=$(printf '\t')
  while IFS="$tab" read -r file hash; do printf '%s\000%s\n' "$file" "$hash" >> "$work/hash-input"; done < "$work/rows"
  [ "$(checksum "$work/hash-input")" = "$(awk -F '\t' '$1=="version" {print $2}' "$1")" ] || fail 'Skill manifest checksum mismatch'
}
verify_installed() {
  [ ! -L "$destination" ] || fail 'Refusing a symlink destination'
  if [ ! -e "$destination" ]; then return; fi
  if [ -d "$destination" ]; then
    entries=$(find "$destination/." ! -name . -print -quit) || fail 'Could not inspect skill destination'
    [ -n "$entries" ] || return 0
  fi
  [ -d "$destination" ] && [ -f "$destination/manifest.tsv" ] || fail 'Existing skill is unmanaged or modified; use its original installer or an empty directory'
  validate "$destination/manifest.tsv"
  [ -z "$(find "$destination" -type l -print)" ] || fail 'Refusing symlinks in the installed skill'
  [ -z "$(find "$destination" ! -type d ! -type f -print)" ] || fail 'Unsupported installed file'
  expected=$(awk -F '\t' '$1=="file" {n++} END {print n+1}' "$destination/manifest.tsv")
  actual=$(find "$destination" -type f | wc -l | tr -d ' ')
  [ "$actual" = "$expected" ] || fail 'Skill has modified or additional files; preserve local changes'
  expected_dirs=$(awk -F '\t' '$1=="file" && index($3,"/") {split($3,parts,"/"); dirs[parts[1]]=1} END {n=1; for(d in dirs) n++; print n}' "$destination/manifest.tsv")
  actual_dirs=$(find "$destination" -type d | wc -l | tr -d ' ')
  [ "$actual_dirs" = "$expected_dirs" ] || fail 'Skill has additional directories; preserve local changes'
  while IFS="$(printf '\t')" read -r kind hash file || [ -n "$kind" ]; do
    [ "$kind" = file ] || continue
    [ -f "$destination/$file" ] && [ "$(checksum "$destination/$file")" = "$hash" ] || fail "Skill is locally modified: $file; preserve local changes"
  done < "$destination/manifest.tsv"
}
fetch "$releases/latest/download/skill-manifest.tsv" "$work/manifest.tsv"
validate "$work/manifest.tsv"
release=$(awk -F '\t' '$1=="release" {print $2}' "$work/manifest.tsv")
version=$(awk -F '\t' '$1=="version" {print $2}' "$work/manifest.tsv")
verify_installed
previous=
if [ -f "$destination/manifest.tsv" ]; then previous=$(awk -F '\t' '$1=="version" {print $2}' "$destination/manifest.tsv"); fi
if [ "$action" = check ]; then
  if [ -z "$previous" ]; then status=missing; elif [ "$previous" = "$version" ]; then status=current; else status=update_available; fi
  printf '%s %s %s\n' "$status" "$version" "$destination"; exit 0
fi
if [ "$previous" = "$version" ]; then printf 'current %s %s\n' "$version" "$destination"; exit 0; fi
[ "$action" != update ] || [ -n "$previous" ] || fail 'Skill is not installed; run install first'
parent=$(dirname "$destination")
mkdir -p "$parent"
mkdir "$destination.install-lock" 2>/dev/null || fail "Another installation is active; inspect $destination.install-lock"
locked="$destination.install-lock"
staging=$(mktemp -d "$parent/.artifact-site-stage.XXXXXXXX")
while IFS="$(printf '\t')" read -r kind hash file || [ -n "$kind" ]; do
  [ "$kind" = file ] || continue
  mkdir -p "$staging/$(dirname "$file")"
  asset=$(printf '%s' "$file" | sed 's|/|--|g')
  fetch "$releases/download/$release/skill--$asset" "$staging/$file"
  [ "$(checksum "$staging/$file")" = "$hash" ] || fail "Skill file checksum mismatch: $file"
done < "$work/manifest.tsv"
cp "$work/manifest.tsv" "$staging/manifest.tsv"
verify_installed
current=
if [ -f "$destination/manifest.tsv" ]; then current=$(awk -F '\t' '$1=="version" {print $2}' "$destination/manifest.tsv"); fi
[ "$current" = "$previous" ] || fail 'Skill changed during installation'
if [ -d "$destination" ]; then backup="$staging-previous"; mv "$destination" "$backup"; fi
mv "$staging" "$destination"
staging=
printf 'installed %s %s\n' "$version" "$destination"
# Editors do not share the installer lock; retain saves made during the swap for recovery.
if [ -n "$backup" ]; then printf 'Previous skill retained at %s\n' "$backup"; fi
printf '%s\n' 'Read SKILL.md before continuing. Existing account credentials are unchanged.'
