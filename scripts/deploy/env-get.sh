#!/usr/bin/env bash
# Prints one value from .env (shell environment wins), or the given default.
#   env-get.sh ARTIFACT_PORT 4300
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
name="$1"; default="${2:-}"
value="${!name:-}"
printf '%s\n' "${value:-$default}"
