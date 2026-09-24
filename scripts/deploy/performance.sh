#!/usr/bin/env bash
# Read-only public-edge probe. No cookies or account credentials are accepted.
set -euo pipefail
base="${1:?Usage: performance.sh https://your-domain.example}"
if [[ ! "$base" =~ ^https?://[^/?#@]+/?$ ]]; then
  echo "Pass a bare HTTP(S) origin without credentials, query or path." >&2; exit 1
fi
base="${base%/}"
if ! curl --version | grep -q HTTP2; then
  echo "This curl has no HTTP/2 support; use an HTTP/2-enabled build to check ALPN." >&2; exit 2
fi
for path in /explore /me /for-agents; do
  printf '%s ' "$path"
  curl --http2 --compressed --silent --show-error --max-time 20 --output /dev/null \
    --write-out 'status=%{http_code} protocol=%{http_version} first_byte=%{time_starttransfer}s total=%{time_total}s bytes=%{size_download}\n' "$base$path"
done
