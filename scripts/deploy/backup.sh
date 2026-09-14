#!/usr/bin/env bash
# Point-in-time backup of everything this deployment owns: a pg_dump of the metadata and, when
# files live on the local disk, a tarball of the data directory. Output: backups/<timestamp>/.
# Files in an S3 bucket are NOT copied — back the bucket up with its own tooling (versioning /
# replication); the manifest records which bucket so a restore knows what it needs.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env

ts="$(date +%Y%m%d-%H%M%S)"
out="${BACKUP_DIR:-$ROOT/backups}/$ts"
mkdir -p "$out"

info "metadata → $out/db.dump"
# -Fc (custom format) restores with pg_restore --clean, which is what restore.sh uses.
pg_tool pg_dump -Fc --no-owner > "$out/db.dump"
ok "$(du -h "$out/db.dump" | cut -f1) db.dump"

if local_files; then
  dp="$(data_path)"
  info "files ($dp) → $out/files.tar.gz"
  if [ -d "$dp" ]; then
    # `builds/` is scratch space for server-side builds; never worth keeping.
    tar -C "$dp" --exclude=./builds -czf "$out/files.tar.gz" .
    ok "$(du -h "$out/files.tar.gz" | cut -f1) files.tar.gz"
  else
    warn "$dp does not exist yet (nothing has been uploaded); skipping files."
  fi
  files_note="local:$dp"
else
  warn "Files live in the S3 bucket ${ARTIFACT_S3_BUCKET:-?}; this script does not copy them. Back them up with the bucket's versioning/replication features."
  files_note="s3:${ARTIFACT_S3_BUCKET:-?}@${ARTIFACT_S3_ENDPOINT:-?}"
fi

cat > "$out/manifest.txt" <<EOF
created=$ts
metadata=$(bundled_postgres && echo "bundled" || echo "external")
files=$files_note
public_url=${ARTIFACT_PUBLIC_URL:-}
git=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)
EOF
ok "Backup complete: $out"
echo "Restore with: make restore FROM=$out"
