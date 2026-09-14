#!/usr/bin/env bash
# Shared by scripts/deploy/*.sh and the Makefile. Reads .env and answers "which pieces of the
# stack does this deployment need" — the one place that logic lives.
#
# Rules (mirrored in prose in SELFHOST.md):
#   ARTIFACT_DATABASE_URL empty            → bundled Postgres (compose/postgres.yml)
#   ARTIFACT_S3_BUCKET empty               → files on the local disk (no extra service either way)
#   ARTIFACT_WITH_GOTENBERG=on, no GOTENBERG_URL → bundled Gotenberg (compose/gotenberg.yml)
#   ARTIFACT_WITH_CADDY=on                 → bundled Caddy (compose/caddy.yml)

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"

# Load .env the way compose does (godotenv rules, the subset that matters): KEY=VALUE per line,
# leading whitespace ignored, `#` lines are comments, an UNQUOTED value is trimmed and loses a
# trailing ` # comment`, a quoted value is taken verbatim between the quotes. Values are never
# shell-expanded. Diverging from compose here would make doctor complain about a value the app
# never sees — so this mirrors compose, and doctor.sh only reports what compose would not accept.
load_env() {
  [ -f "$ENV_FILE" ] || return 0
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"          # ltrim
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="${value#"${value%%[![:space:]]*}"}"       # ltrim value
    if [[ "$value" =~ ^\"(.*)\"[[:space:]]*(#.*)?$ ]] || [[ "$value" =~ ^\'(.*)\'[[:space:]]*(#.*)?$ ]]; then
      value="${BASH_REMATCH[1]}"
    else
      # NB: `KEY= # note` is NOT empty to compose — the value becomes `# note` (verified with
      # `docker compose config`). Mirrored here; doctor.sh flags such lines by name.
      value="${value%%[[:space:]]#*}"                 # drop inline comment
      value="${value%"${value##*[![:space:]]}"}"      # rtrim
    fi
    # Only fill in what the caller's environment does not already provide (shell overrides file).
    if [ -z "${!key+x}" ]; then export "$key=$value"; fi
  done < "$ENV_FILE"
}

bundled_postgres() { [ -z "${ARTIFACT_DATABASE_URL:-}" ]; }
# Same rule as lib/config.storageDriver: explicit driver wins, otherwise the bucket decides.
local_files() {
  case "${ARTIFACT_STORAGE_DRIVER:-}" in
    local) return 0 ;;
    s3)    return 1 ;;
    *)     [ -z "${ARTIFACT_S3_BUCKET:-}" ] ;;
  esac
}
bundled_gotenberg(){ [ "${ARTIFACT_WITH_GOTENBERG:-}" = "on" ] && [ -z "${GOTENBERG_URL:-}" ]; }
bundled_caddy()    { [ "${ARTIFACT_WITH_CADDY:-}" = "on" ]; }

# The compose file list, in layering order, as a proper array (paths may contain spaces).
COMPOSE_FILES=()
compose_files_array() {
  COMPOSE_FILES=(-f "$ROOT/docker-compose.yml")
  bundled_postgres  && COMPOSE_FILES+=(-f "$ROOT/compose/postgres.yml")
  bundled_gotenberg && COMPOSE_FILES+=(-f "$ROOT/compose/gotenberg.yml")
  bundled_caddy     && COMPOSE_FILES+=(-f "$ROOT/compose/caddy.yml")
  # Callers run under `set -e`; a false `cond && …` as the last line would return 1 and abort them.
  return 0
}

# Human-readable form of the same list (relative to the repo), for doctor's plan line.
compose_files() {
  compose_files_array
  local out="" f
  for f in "${COMPOSE_FILES[@]}"; do out="$out ${f#"$ROOT/"}"; done
  echo "${out# }"
}

compose() {
  compose_files_array
  docker compose --project-directory "$ROOT" "${COMPOSE_FILES[@]}" "$@"
}

data_path() {
  local p="${ARTIFACT_DATA_PATH:-./data}"
  case "$p" in /*) echo "$p" ;; *) echo "$ROOT/${p#./}" ;; esac
}

pg_data_path() {
  local p="${POSTGRES_DATA_PATH:-./pgdata}"
  case "$p" in /*) echo "$p" ;; *) echo "$ROOT/${p#./}" ;; esac
}

pg_image() { echo "${POSTGRES_IMAGE:-postgres:18-alpine}"; }

# `postgres://user:secret@host/db` → `postgres://user:***@host/db`. Greedy up to the LAST `@`, so a
# password that itself contains `@` is still fully hidden.
redact_url() { printf '%s\n' "$1" | sed -E 's#://([^:/@]+):.*@#://\1:***@#'; }

# Run a postgres client tool against whichever database this deployment uses.
#   pg_tool pg_dump -Fc   → bundled: inside the postgres container; external: a throwaway
#   container on the host network so the URL resolves exactly as it would for the app.
pg_tool() {
  local tool="$1"; shift
  if bundled_postgres; then
    compose exec -T postgres "$tool" -U artifact_hub -d artifact_hub "$@"
  else
    docker run --rm -i --network host "$(pg_image)" "$tool" "$@" -d "$ARTIFACT_DATABASE_URL"
  fi
}

info() { printf '\033[1;34m»\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*"; }
