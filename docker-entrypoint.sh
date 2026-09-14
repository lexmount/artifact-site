#!/bin/sh
set -e

: "${ARTIFACT_DATA_DIR:=/data}"

# Next.js standalone binds to $HOSTNAME. Kubernetes and most PaaS auto-set HOSTNAME to
# the pod name, which would bind the server to the pod hostname instead of all
# interfaces — breaking the gateway and the 127.0.0.1 health probe. Force it.
export HOSTNAME=0.0.0.0

mkdir -p "$ARTIFACT_DATA_DIR"

# Warn (don't fail) if the state dir isn't a real mount: a common misconfig that
# silently writes to the ephemeral layer and loses everything on the next
# redeploy. A plain `docker run` without a volume is still allowed for a quick try.
if command -v mountpoint >/dev/null 2>&1 && ! mountpoint -q "$ARTIFACT_DATA_DIR"; then
  echo "WARN: $ARTIFACT_DATA_DIR is not a mounted volume — uploads will NOT" >&2
  echo "      persist across a redeploy. Mount a persistent volume here (or use S3 storage)." >&2
fi

# Probe whether $ARTIFACT_DATA_DIR is writable, optionally under a privilege-drop
# prefix ($1, e.g. "setpriv --reuid ...").
writable_as() {
  $1 sh -c "touch '$ARTIFACT_DATA_DIR/.wtest' && rm -f '$ARTIFACT_DATA_DIR/.wtest'" 2>/dev/null
}

if [ "$(id -u)" = "0" ]; then
  # Repair ownership only when it's actually wrong (cheap top-level stat) so we
  # never pay an O(files) recursive chown on a large data dir every boot.
  if [ "$(stat -c '%u' "$ARTIFACT_DATA_DIR" 2>/dev/null)" != "1001" ]; then
    chown -R nextjs:nodejs "$ARTIFACT_DATA_DIR" 2>/dev/null || true
  fi
  SP="setpriv --reuid nextjs --regid nodejs --init-groups"
  # On NFS with root_squash the chown above is a silent no-op — verify the app
  # user can really write, and fail loudly instead of a cryptic SQLite EACCES.
  if ! writable_as "$SP"; then
    echo "FATAL: $ARTIFACT_DATA_DIR is not writable by the app user (uid 1001)." >&2
    echo "  Likely NFS/shared storage with root_squash. Use node-local (RWO, block)" >&2
    echo "  storage for /data, or pre-provision it owned by uid 1001." >&2
    exit 1
  fi
  exec $SP "$@"
fi

# Platform pinned a non-root UID (restricted SecurityContext): can't chown, so
# just verify writability and fail fast with an actionable message.
if ! writable_as ""; then
  echo "FATAL: $ARTIFACT_DATA_DIR not writable by uid $(id -u). Set the pod's" >&2
  echo "  fsGroup to 1001 on the /data volume, or run the component as root or uid 1001." >&2
  exit 1
fi
exec "$@"
