#!/usr/bin/env bash
# Restore a backups/<timestamp>/ directory made by backup.sh. Stops the app for the duration
# (the stack's other services keep running), replaces the metadata, moves the current data
# directory aside (never deletes it) and unpacks the backed-up files in its place.
#   make restore FROM=backups/20260904-120000
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env

from="${1:-${FROM:-}}"
[ -n "$from" ] || { fail "Usage: make restore FROM=backups/<timestamp>"; exit 1; }
case "$from" in /*) ;; *) from="$ROOT/${from#./}" ;; esac
[ -f "$from/db.dump" ] || { fail "$from/db.dump does not exist."; exit 1; }

[ -f "$from/manifest.txt" ] && { info "manifest:"; sed 's/^/    /' "$from/manifest.txt"; }
if [ "${FORCE:-}" != "1" ]; then
  echo
  warn "This overwrites the current metadata database and file directory with the backup (the current file directory is renamed and kept first)."
  read -r -p "Continue? Type yes: " answer
  [ "$answer" = "yes" ] || { info "Cancelled."; exit 0; }
fi

info "Stopping the app"
compose stop app >/dev/null

info "Restoring metadata"
# --clean --if-exists drops and recreates every object in the dump, so a restore onto a
# non-empty database ends up as the snapshot, not a merge.
pg_tool pg_restore --clean --if-exists --no-owner < "$from/db.dump"
ok "Metadata restored"

if [ -f "$from/files.tar.gz" ]; then
  if local_files; then
    dp="$(data_path)"
    if [ -d "$dp" ]; then
      aside="$dp.before-restore-$(date +%Y%m%d-%H%M%S)"
      # Needs root when the container owned the files (uid 1001); fall back to sudo if we can't.
      mv "$dp" "$aside" 2>/dev/null || sudo mv "$dp" "$aside"
      info "The previous file directory was renamed to $aside (delete it once you have verified the restore)"
    fi
    mkdir -p "$dp"
    tar -C "$dp" -xzf "$from/files.tar.gz"
    ok "Files restored to $dp (the container fixes ownership on startup)"
  else
    warn "The backup contains a file archive, but file storage is currently configured as S3; the archive was not unpacked. Moving the files into the bucket needs to be done separately."
  fi
else
  info "The backup has no file archive (files were in S3 at the time); skipping."
fi

info "Starting the app"
compose up -d app >/dev/null
ok "Restore complete"
