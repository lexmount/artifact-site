# Single-host deployment (docker compose) and day-to-day operations. `make` lists the targets.
# Everything reads .env; which extra services come up is decided by scripts/deploy/lib.sh.
# Platform deployments (Kubernetes, a PaaS) do not use this file at all; they build the Dockerfile directly.
SHELL := /bin/bash
.DEFAULT_GOAL := help

DEPLOY  := scripts/deploy
# Every compose call goes through the wrapper so the file list is computed in one place.
COMPOSE := $(DEPLOY)/compose.sh

# Image name/tag the stack runs. Override in .env (ARTIFACT_IMAGE) or on the command line.
IMAGE   ?= $(shell $(DEPLOY)/env-get.sh ARTIFACT_IMAGE artifact-site:local)
# Target platform for `make image` — the server's, not the laptop's.
PLATFORM ?= linux/amd64
DIST    := dist
TARBALL  = $(DIST)/$(subst /,_,$(subst :,-,$(IMAGE))).tar.gz

.PHONY: help doctor up down restart logs ps build image load pull upgrade backup restore psql dev test test-pg

help: ## List all targets
	@awk 'BEGIN{FS=":.*##"} /^[a-zA-Z_-]+:.*##/{printf "  \033[36m%-10s\033[0m %s\n",$$1,$$2}' $(MAKEFILE_LIST)
	@echo
	@echo "  First deployment: cp .env.example .env → edit it → make up"
	@echo "  If the server cannot build images: make image on a dev machine → copy $(DIST)/*.tar.gz to the server → make load FILE=… → make up"

doctor: ## Pre-flight check of .env, docker, ports and directories; prints which components will be enabled
	@$(DEPLOY)/doctor.sh

up: doctor ## Pre-flight, then start/update the whole stack (.env decides whether Postgres/Gotenberg/Caddy are bundled)
	@$(COMPOSE) up -d --remove-orphans
	@echo; echo "Waiting for the app to become ready…"
	@s=; for i in $$(seq 1 60); do \
	  s=$$(docker inspect -f '{{.State.Health.Status}}' artifact-site 2>/dev/null); \
	  st=$$(docker inspect -f '{{.State.Status}}' artifact-site 2>/dev/null); \
	  if [ "$$s" = healthy ]; then break; fi; \
	  if [ "$$st" = exited ] || [ "$$st" = restarting ] || [ "$$st" = dead ]; then \
	    echo "The app failed to start (status $$st); recent logs:"; $(COMPOSE) logs --no-log-prefix --tail=30 app; \
	    echo; echo "Fix .env and rerun make up (the container keeps retrying; make down first to quiet it)."; exit 1; fi; \
	  sleep 2; done; \
	if [ "$$s" != healthy ]; then echo "Not ready within 120 seconds (status $$st, health $$s); recent logs:"; $(COMPOSE) logs --no-log-prefix --tail=30 app; exit 1; fi
	@$(COMPOSE) logs --no-log-prefix app 2>/dev/null | grep '\[runtime\]' | tail -8
	@echo; echo "The app is at http://$$($(DEPLOY)/env-get.sh ARTIFACT_BIND 127.0.0.1):$$($(DEPLOY)/env-get.sh ARTIFACT_PORT 4300)  (public URL: $$($(DEPLOY)/env-get.sh ARTIFACT_PUBLIC_URL unset))"

down: ## Stop and remove the containers (the data directory and database volume are kept)
	@$(COMPOSE) down --remove-orphans

restart: ## Restart the app container (use after editing .env; required after changing ARTIFACT_S3_*)
	@$(COMPOSE) up -d --force-recreate app

logs: ## Follow the app logs
	@$(COMPOSE) logs -f --tail=200 app

ps: ## Show the status of each container
	@$(COMPOSE) ps

build: ## Build the image locally (NODE_IMAGE / NPM_REGISTRY from .env are passed as build args)
	@$(COMPOSE) build app

image: ## On a dev machine, build the image for the server platform and pack it into dist/ (for servers that cannot reach Docker Hub / npm)
	@mkdir -p $(DIST)
	docker build --platform $(PLATFORM) -t $(IMAGE) \
	  --build-arg NODE_IMAGE=$$($(DEPLOY)/env-get.sh NODE_IMAGE node:24-bookworm-slim) \
	  --build-arg NPM_REGISTRY=$$($(DEPLOY)/env-get.sh NPM_REGISTRY '') .
	docker save $(IMAGE) | gzip > $(TARBALL)
	@echo; echo "Image tarball: $(TARBALL) ($$(du -h $(TARBALL) | cut -f1))"; echo "On the server: make load FILE=$(TARBALL) && make up"

load: ## Load an image tarball produced by make image: make load FILE=dist/xxx.tar.gz
	@test -n "$(FILE)" || { echo "Usage: make load FILE=dist/<name>.tar.gz"; exit 1; }
	gunzip -c $(FILE) | docker load

pull: ## Pull ARTIFACT_IMAGE from the registry
	@$(COMPOSE) pull app

upgrade: ## Pull code + rebuild the image + restart (one-step upgrade when the server can build; exits non-zero on failure)
	git pull --ff-only
	@$(MAKE) build
	@$(MAKE) up

backup: ## Back up to backups/<timestamp>/ (pg_dump + tarball of the local file directory)
	@$(DEPLOY)/backup.sh

restore: ## Restore from a backup: make restore FROM=backups/<timestamp>
	@$(DEPLOY)/restore.sh $(FROM)

psql: ## Open a database shell
	@. $(DEPLOY)/lib.sh; load_env; if bundled_postgres; then compose exec postgres psql -U artifact_hub -d artifact_hub; \
	  else docker run --rm -it --network host "$$(pg_image)" psql "$$ARTIFACT_DATABASE_URL"; fi

dev: ## Local development: start a Postgres container, then run next dev (no .env needed)
	@POSTGRES_PASSWORD=$${POSTGRES_PASSWORD:-artifact_hub_dev} docker compose --project-directory . -f docker-compose.yml -f compose/postgres.yml up -d --wait postgres
	ARTIFACT_DATABASE_URL=postgres://artifact_hub:$${POSTGRES_PASSWORD:-artifact_hub_dev}@127.0.0.1:$$($(DEPLOY)/env-get.sh POSTGRES_PORT 55432)/artifact_hub?sslmode=disable npm run dev

test: ## Unit tests (SQLite-backed; no external services needed)
	npm test

test-pg: ## Run the integration tests against a real Postgres (throwaway container, removed afterwards)
	@set -e; name=artifact-site-testpg-$$$$; port=$$((20000 + RANDOM % 20000)); \
	  docker run -d --rm --tmpfs /var/lib/postgresql --name $$name -e POSTGRES_USER=t -e POSTGRES_PASSWORD=t -e POSTGRES_DB=t -p 127.0.0.1:$$port:5432 $$($(DEPLOY)/env-get.sh POSTGRES_IMAGE postgres:18-alpine) >/dev/null; \
	  trap "docker stop $$name >/dev/null" EXIT; \
	  for i in $$(seq 1 30); do docker exec $$name pg_isready -U t -d t >/dev/null 2>&1 && break; sleep 1; done; \
	  ARTIFACT_DATABASE_URL=postgres://t:t@127.0.0.1:$$port/t?sslmode=disable npx vitest run test/db-postgres.integration.test.ts; \
	  ARTIFACT_DB_DRIVER=postgres ARTIFACT_DATABASE_URL=postgres://t:t@127.0.0.1:$$port/t?sslmode=disable npx vitest run test/admin.test.ts test/quota.test.ts test/settings.test.ts test/site-text.test.ts test/rbac.test.ts test/rbac-convergence.test.ts test/permission-audit-regressions.test.ts test/comment-access.test.ts test/comments-service.test.ts test/official-version.test.ts test/official-api.test.ts test/comments-anchored.test.ts test/publish-recovery.test.ts test/publish-client-recovery.test.ts
