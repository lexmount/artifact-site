#!/usr/bin/env bash
# Pre-flight for `make up`: catches the configuration mistakes that would otherwise surface as a
# container that starts fine and fails on the first upload. Same rules as src/lib/runtime.ts,
# checked before a container exists. Exit 1 on any error; warnings do not block.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

errors=0
warnings=0
err()  { fail "$*"; errors=$((errors + 1)); }
wrn()  { warn "$*"; warnings=$((warnings + 1)); }

# ---- tooling ------------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  err "docker is not on PATH."
elif ! docker info >/dev/null 2>&1; then
  err "Cannot reach the docker daemon (the current user lacks permission, or the service is not running)."
else
  ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
fi
if docker compose version >/dev/null 2>&1; then
  cv="$(docker compose version --short 2>/dev/null)"
  # env_file.required (used by docker-compose.yml) needs compose 2.24+.
  major="${cv%%.*}"; rest="${cv#*.}"; minor="${rest%%.*}"
  if [ "${major:-0}" -lt 2 ] || { [ "${major:-0}" -eq 2 ] && [ "${minor:-0}" -lt 24 ]; }; then
    err "docker compose $cv is too old; 2.24 or newer is required (for the env_file.required syntax)."
  else
    ok "docker compose $cv"
  fi
else
  err "docker compose (the v2 plugin) is not available."
fi

# ---- .env ----------------------------------------------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  err ".env does not exist: cp .env.example .env, then fill it in following the comments."
  echo; fail "$errors error(s)."; exit 1
fi
if grep -q $'\r' "$ENV_FILE"; then err ".env has CRLF line endings (Windows format); compose will treat the \\r as part of the value."; fi
# Same shape compose accepts: optional leading whitespace, KEY=…, or a comment / blank line.
bad_lines="$(grep -nvE '^[[:space:]]*(#|$)|^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" || true)"
if [ -n "$bad_lines" ]; then err ".env has lines that are not in KEY=VALUE form (no export, no spaces around the equals sign):"$'\n'"$bad_lines"; fi
# `KEY= # note` is not an empty value to compose: the app receives the literal `# note`.
hash_lines="$(grep -nE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=[[:space:]]*#' "$ENV_FILE" || true)"
if [ -n "$hash_lines" ]; then err ".env has lines like \"KEY= # comment\": compose passes \"# ...\" to the app as the value. For an empty value write just KEY= and put the comment on its own line:"$'\n'"$hash_lines"; fi
dollar_lines="$(grep -nE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=.*\$' "$ENV_FILE" | grep -v '\$\$' || true)"
if [ -n "$dollar_lines" ]; then wrn ".env has values containing \$: compose treats it as variable interpolation. Write a literal \$ as \$\$."$'\n'"$dollar_lines"; fi
load_env

# ---- required ------------------------------------------------------------------------------
url="${ARTIFACT_PUBLIC_URL:-}"
if [ -z "$url" ]; then
  wrn "ARTIFACT_PUBLIC_URL is not set. It is required behind a reverse proxy; otherwise the OIDC callback, CSRF checks and the addresses in /for-agents.md are guessed from the request Host."
elif ! [[ "$url" =~ ^https?://[^/]+$ ]]; then
  err "ARTIFACT_PUBLIC_URL=$url has the wrong format: expected http(s)://host[:port], with no path and no trailing slash."
elif [[ "$url" =~ ^https?://([^/:]+\.)?example\.(net|com|org)(:[0-9]+)?$ ]]; then
  err "ARTIFACT_PUBLIC_URL=$url is still the template placeholder. Set it to this site's real address; otherwise writes are rejected by the Origin check, the OIDC callback points at example.net, and agents get a bogus API address."
else
  ok "public url $url"
fi

# ---- metadata ------------------------------------------------------------------------------
case "${ARTIFACT_DB_DRIVER:-}" in
  ''|postgres) ;;
  sqlite) err "ARTIFACT_DB_DRIVER=sqlite is for the test runner only; production deployments must use Postgres: remove this variable." ;;
  *) err "ARTIFACT_DB_DRIVER=${ARTIFACT_DB_DRIVER} is not recognised; the only valid value is postgres (or leave it empty)." ;;
esac
if bundled_postgres; then
  if [ -z "${POSTGRES_PASSWORD:-}" ]; then
    # No default on purpose (a template default ends up on public IPs); generate one and write it
    # back so the minimal .env stays minimal. Replace an existing empty line rather than append —
    # compose would otherwise read whichever copy wins.
    gen="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
    if grep -qE '^[[:space:]]*POSTGRES_PASSWORD=' "$ENV_FILE"; then
      sed -i.bak -E "s|^[[:space:]]*POSTGRES_PASSWORD=.*$|POSTGRES_PASSWORD=$gen|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
    else
      printf '\nPOSTGRES_PASSWORD=%s\n' "$gen" >> "$ENV_FILE"
    fi
    export POSTGRES_PASSWORD="$gen"
    ok "metadata: bundled Postgres ($(pg_image)). POSTGRES_PASSWORD was empty; generated one and wrote it back to .env (do not change it once set)."
  elif ! [[ "${POSTGRES_PASSWORD}" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    err "POSTGRES_PASSWORD contains characters that are special in URLs and would break the connection string. Use only letters, digits, _ . -."
  else
    pdp="$(pg_data_path)"
    ok "metadata: bundled Postgres ($(pg_image)), data directory ${POSTGRES_DATA_PATH:-./pgdata}"
    if [ -d "$pdp" ] && [ -n "$(ls -A "$pdp" 2>/dev/null)" ]; then
      info "  The data directory is already initialised: the database password was fixed on first start, so changing POSTGRES_PASSWORD in .env later does not change it (to change it, run make psql → ALTER ROLE artifact_hub PASSWORD '…' first, then update .env)."
    fi
  fi
else
  if [[ "${ARTIFACT_DATABASE_URL}" =~ ^postgres(ql)?:// ]]; then
    ok "metadata: external Postgres $(redact_url "$ARTIFACT_DATABASE_URL")"
  else
    err "ARTIFACT_DATABASE_URL is not a postgres:// connection string."
  fi
fi

# A pre-release SQLite deployment of this repo (the old docker-compose.yml named the container
# `aigc-artifact-platform`; named volume `<project>_artifact-data` holding sites.sqlite). This
# version has no sqlite→postgres migration and `make up --remove-orphans` will remove that
# container — say so before somebody concludes the upgrade lost their data.
legacy_ct="$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -x 'aigc-artifact-platform' || true)"
legacy_vol="$(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -E '(^|_)artifact-data$' || true)"
if [ -n "$legacy_ct$legacy_vol" ]; then
  wrn "Leftovers of a legacy (SQLite) deployment detected: ${legacy_ct:+container $legacy_ct }${legacy_vol:+named volume $legacy_vol}. This version does not migrate SQLite data; make up removes the old container as an orphan and leaves the old volume in place, unmounted. Old sites will not appear in the new database. To keep the old data, docker cp sites.sqlite and sites/ out before upgrading."
fi

# ---- files ---------------------------------------------------------------------------------
case "${ARTIFACT_STORAGE_DRIVER:-}" in
  ''|local|s3) ;;
  *) err "ARTIFACT_STORAGE_DRIVER=${ARTIFACT_STORAGE_DRIVER} is not recognised; valid values are local / s3 (or leave it empty to infer from the S3 variables)." ;;
esac
if local_files; then
  dp="$(data_path)"
  ok "files: local disk $dp"
  if [ -n "${ARTIFACT_S3_BUCKET:-}" ]; then wrn "ARTIFACT_S3_BUCKET is configured but ARTIFACT_STORAGE_DRIVER=local is set explicitly; files will not go to the bucket."; fi
  if [ -e "$dp" ] && [ ! -d "$dp" ]; then err "$dp exists but is not a directory."; fi
  if [ -d "$dp" ] && [ ! -w "$dp" ]; then wrn "$dp is not writable by the current user; the container fixes ownership as root, which is usually fine."; fi
  if [ -d "$dp" ] && command -v stat >/dev/null 2>&1; then
    fstype="$(stat -f -c %T "$dp" 2>/dev/null || true)"
    case "$fstype" in nfs*|cifs|smb*) wrn "$dp is on $fstype. root_squash stops the container from fixing ownership, so startup will FATAL." ;; esac
  fi
else
  missing=""
  for k in ARTIFACT_S3_ENDPOINT ARTIFACT_S3_BUCKET ARTIFACT_S3_ACCESS_KEY_ID ARTIFACT_S3_SECRET_ACCESS_KEY; do
    [ -n "${!k:-}" ] || missing="$missing $k"
  done
  if [ -n "$missing" ]; then err "File storage is set to S3, but these are missing:$missing"; else ok "files: S3 bucket ${ARTIFACT_S3_BUCKET} @ ${ARTIFACT_S3_ENDPOINT}"; fi
fi

# ---- numbers -------------------------------------------------------------------------------
for k in ARTIFACT_MAX_BYTES ARTIFACT_MAX_FILES ARTIFACT_MAX_FILE_BYTES ARTIFACT_INLINE_UPLOAD_MAX_BYTES \
         ARTIFACT_RATE_LIMIT_BURST ARTIFACT_RATE_LIMIT_PER_MIN ARTIFACT_RATE_LIMIT_MAX_KEYS \
         ARTIFACT_S3_CACHE_BYTES ARTIFACT_CONVERT_TIMEOUT_MS ARTIFACT_CONVERT_CONCURRENCY ARTIFACT_DELETED_RETENTION_DAYS ARTIFACT_QUOTA_SITES_PER_USER ARTIFACT_QUOTA_BYTES_PER_USER \
         ARTIFACT_QUOTA_SITES_PER_ANON ARTIFACT_QUOTA_BYTES_PER_ANON ARTIFACT_ANON_SITE_TTL_DAYS ARTIFACT_AUDIT_RETENTION_DAYS ARTIFACT_PORT POSTGRES_PORT; do
  v="${!k:-}"
  if [ -n "$v" ] && ! [[ "$v" =~ ^[0-9]+$ ]]; then err "$k=$v is not a plain number. Numeric variables accept only byte counts / integers; a value like 50MB is silently ignored."; fi
done

if [[ "${ARTIFACT_AUDIT_RETENTION_DAYS:-0}" =~ ^[0-9]+$ ]] && [ "${ARTIFACT_AUDIT_RETENTION_DAYS:-0}" -gt 3650 ]; then
  err "ARTIFACT_AUDIT_RETENTION_DAYS must be between 0 and 3650; invalid values disable audit cleanup."
fi

# ---- who may create ------------------------------------------------------------------------
policy="${ARTIFACT_CREATE_POLICY:-}"
if [ -z "$policy" ]; then policy=$([ -n "${PUBLISH_API_TOKEN:-}" ] && echo token || echo open); fi
oidc_ok=0; [ -n "${ARTIFACT_OIDC_ISSUER:-}" ] && [ -n "${ARTIFACT_OIDC_CLIENT_ID:-}" ] && [ -n "${ARTIFACT_OIDC_CLIENT_SECRET:-}" ] && oidc_ok=1
case "$policy" in
  open)
    if [ -n "$url" ]; then
      wrn "Create policy open: anyone who can reach the service can upload. Fine for internal use; for public deployments set ARTIFACT_CREATE_POLICY=login (with OIDC) or token."
    else ok "create policy: open"; fi ;;
  login)
    if [ $oidc_ok -eq 1 ]; then ok "create policy: login (OIDC ${ARTIFACT_OIDC_ISSUER})"; else err "ARTIFACT_CREATE_POLICY=login needs all three OIDC settings (ISSUER / CLIENT_ID / CLIENT_SECRET). Without an IdP, switch to token (with PUBLISH_API_TOKEN; only scripts/agents can publish) or open (internal networks)."; fi ;;
  token)
    if [ -n "${PUBLISH_API_TOKEN:-}" ]; then ok "create policy: token (drag-and-drop uploads in the web UI will get 401; only scripts/agents can publish)"; else err "ARTIFACT_CREATE_POLICY=token but PUBLISH_API_TOKEN is empty."; fi ;;
  *) err "ARTIFACT_CREATE_POLICY=$policy is not recognised; valid values are open / login / token." ;;
esac
if [ -n "${ARTIFACT_ENFORCE_OWNERSHIP:-}" ]; then
  info "ARTIFACT_ENFORCE_OWNERSHIP is deprecated and ignored; RBAC is always enforced."
fi
if [ $oidc_ok -eq 1 ] && [ -z "$url" ]; then err "ARTIFACT_PUBLIC_URL is required when OIDC is configured; the callback URL is derived from it."; fi
case "${ARTIFACT_DEFAULT_VISIBILITY:-}" in
  '') [ -n "$url" ] && info "ARTIFACT_DEFAULT_VISIBILITY is not set: new sites default to private (links 404 for others until shared). For internal use where links should open directly, set it to public." ;;
  public|unlisted|private) ok "default visibility: ${ARTIFACT_DEFAULT_VISIBILITY}" ;;
  *) err "ARTIFACT_DEFAULT_VISIBILITY=${ARTIFACT_DEFAULT_VISIBILITY} is not recognised; valid values are public / unlisted / private." ;;
esac

# ---- optional services ---------------------------------------------------------------------
if bundled_gotenberg; then ok "document conversion: bundled Gotenberg (${GOTENBERG_IMAGE:-gotenberg/gotenberg:8})";
elif [ -n "${GOTENBERG_URL:-}" ]; then ok "document conversion: external ${GOTENBERG_URL}";
else info "document conversion: off (Office documents show as download cards; set ARTIFACT_WITH_GOTENBERG=on to enable)"; fi
if bundled_caddy; then
  if [ -z "${ARTIFACT_DOMAIN:-}" ]; then err "ARTIFACT_WITH_CADDY=on requires ARTIFACT_DOMAIN."; else
    ok "proxy: bundled Caddy, domain ${ARTIFACT_DOMAIN} (ports 80/443 must be free and reachable from the internet)"
    if [ -n "$url" ] && [[ "$url" != "https://${ARTIFACT_DOMAIN}" ]]; then wrn "ARTIFACT_PUBLIC_URL and ARTIFACT_DOMAIN do not match ($url vs https://${ARTIFACT_DOMAIN})."; fi
  fi
else
  info "proxy: not bundled (point your existing reverse proxy at ${ARTIFACT_BIND:-127.0.0.1}:${ARTIFACT_PORT:-4300})"
fi

# ---- ports ---------------------------------------------------------------------------------
port_busy() {
  if command -v ss >/dev/null 2>&1; then ss -Hltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$";
  elif command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1;
  else return 1; fi
}
# A port held by one of OUR containers (a previous `make up`) is fine; anything else gets a warning.
ours_port() { docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -E '^artifact-site(-postgres|-caddy)? ' | grep -qE "[:.]$1->"; }
for p in "${ARTIFACT_PORT:-4300}" $(bundled_postgres && echo "${POSTGRES_PORT:-55432}") $(bundled_caddy && echo "80 443"); do
  if port_busy "$p" && ! ours_port "$p"; then wrn "Port $p is already in use by another process."; fi
done

# ---- plan ----------------------------------------------------------------------------------
echo
info "compose files: $(compose_files)"
if [ $errors -gt 0 ]; then echo; fail "$errors error(s), $warnings warning(s). Fix .env and rerun make doctor."; exit 1; fi
if [ $warnings -gt 0 ]; then echo; warn "$warnings warning(s); startup is not blocked."; fi
exit 0
