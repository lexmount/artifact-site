#!/usr/bin/env bash
# `docker compose` with the file list this .env calls for. The Makefile routes every compose call
# through here so the list is computed in one place (lib.sh) and paths with spaces survive.
#   scripts/deploy/compose.sh ps
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
compose "$@"
