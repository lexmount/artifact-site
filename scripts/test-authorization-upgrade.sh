#!/bin/bash
# Usage: bash scripts/test-authorization-upgrade.sh OLD_0_2_0_IMAGE NEW_IMAGE
# Uses only disposable containers, a private network and a temporary artifact volume.
set -euo pipefail
old_image="${1:?Pass an image built from 0.2.0 (19f9c3b)}"
new_image="${2:?Pass the cleanup image}"
cd "$(dirname "$0")/.."
suffix="$$"
network="rbac-cleanup-upgrade-$suffix"
pg="rbac-cleanup-pg-$suffix"
old="rbac-cleanup-old-$suffix"
first="rbac-cleanup-first-$suffix"
second="rbac-cleanup-second-$suffix"
volume="rbac-cleanup-data-$suffix"
upgrade_tmp=$(mktemp -d)
cleanup() {
  for app in "$old" "$first" "$second"; do docker logs "$app" > "/tmp/$app.log" 2>&1 || true; done
  docker rm -fv "$old" "$first" "$second" "$pg" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$upgrade_tmp"
}
trap cleanup EXIT
docker network create "$network" >/dev/null
docker volume create "$volume" >/dev/null
docker run -d --rm --tmpfs /var/lib/postgresql --name "$pg" --network "$network" -e POSTGRES_USER=t -e POSTGRES_PASSWORD=t -e POSTGRES_DB=t postgres:18-alpine >/dev/null
for i in {1..40}; do docker exec "$pg" pg_isready -U t -d t >/dev/null 2>&1 && break; sleep 1; done
wait_for_app() {
  local app="$1" port="$2"
  for i in {1..45}; do
    if curl --connect-timeout 2 --max-time 5 -fsS "http://127.0.0.1:$port/" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "Application $app did not become ready" >&2
  docker logs "$app" >&2 || true
  return 1
}
start_app() {
  local app="$1" image="$2"
  docker run -d --name "$app" --network "$network" -p 127.0.0.1::4300 --mount "type=volume,source=$volume,target=/data" -e "ARTIFACT_DATABASE_URL=postgres://t:t@$pg:5432/t?sslmode=disable" -e ARTIFACT_CREATE_POLICY=open -e ARTIFACT_RATE_LIMIT=off "$image" >/dev/null
  local port
  port=$(docker port "$app" 4300/tcp | awk -F: '{print $NF}')
  wait_for_app "$app" "$port" || return 1
  printf '%s' "$port"
}
old_port=$(start_app "$old" "$old_image")
curl -fsS "http://127.0.0.1:$old_port/api/sites" -H 'Content-Type: application/json' --data '{"mode":"paste","html":"<html><title>Upgrade retained</title><body>Preserved content</body></html>"}' > "$upgrade_tmp/site.json"
site_id=$(docker exec "$pg" psql -U t -d t -Atc "SELECT id FROM sites ORDER BY created_at DESC LIMIT 1")
site_slug=$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).slug)' "$upgrade_tmp/site.json")
if [[ "$site_id" != site_* ]]; then echo "Missing published site id" >&2; exit 1; fi
docker exec -i "$pg" psql -U t -d t -v ON_ERROR_STOP=1 < test/fixtures/pre-rbac-grants.sql
[[ $(docker exec "$pg" psql -U t -d t -Atc "SELECT COUNT(*) FROM schema_migrations WHERE id LIKE '0007%'") == 0 ]]
[[ $(docker exec "$pg" psql -U t -d t -Atc "SELECT COUNT(*) FROM rbac_migrations WHERE id='initial'") == 1 ]]
docker stop "$old" >/dev/null
first_port=$(start_app "$first" "$new_image")
second_port=$(start_app "$second" "$new_image")
docker exec -i "$pg" psql -U t -d t -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF to_regclass('site_members') IS NOT NULL OR to_regclass('site_collaborators') IS NOT NULL OR to_regclass('site_invites') IS NOT NULL OR to_regclass('rbac_migrations') IS NOT NULL THEN RAISE EXCEPTION 'retired tables remain'; END IF;
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE (table_name='tenant_members' AND column_name='role') OR (table_name='sites' AND column_name IN ('claim_token','edit_policy'))) THEN RAISE EXCEPTION 'retired columns remain'; END IF;
  IF NOT EXISTS(SELECT 1 FROM role_bindings WHERE id='migrated-tenant:upgrade-workspace:upgrade-admin' AND role_id='tenant-admin') THEN RAISE EXCEPTION 'tenant admin not imported'; END IF;
  IF (SELECT COUNT(*) FROM role_bindings WHERE resource_site_id='upgrade-site' AND created_by='upgrade-owner' AND created_at=12345 AND updated_at=12345 AND revision=1) <> 3 THEN RAISE EXCEPTION 'site grants or metadata lost'; END IF;
  IF NOT EXISTS(SELECT 1 FROM role_bindings WHERE subject_user_id='upgrade-manager' AND role_id='site-admin') THEN RAISE EXCEPTION 'site admin not imported'; END IF;
  IF NOT EXISTS(SELECT 1 FROM role_bindings WHERE subject_user_id='upgrade-editor' AND role_id='editor') THEN RAISE EXCEPTION 'editor not imported'; END IF;
  IF EXISTS(SELECT 1 FROM role_bindings WHERE subject_user_id='upgrade-left') THEN RAISE EXCEPTION 'removed member imported'; END IF;
  IF EXISTS(SELECT 1 FROM authorization_site_members WHERE user_id IN ('upgrade-disabled','upgrade-left')) THEN RAISE EXCEPTION 'ineligible user has access'; END IF;
  IF (SELECT COUNT(*) FROM tenant_members WHERE tenant_id='upgrade-workspace') <> 5 THEN RAISE EXCEPTION 'membership changed'; END IF;
  IF NOT EXISTS(SELECT 1 FROM sites WHERE id='upgrade-site' AND tenant_id='upgrade-workspace' AND owner_id='upgrade-owner') THEN RAISE EXCEPTION 'workspace changed'; END IF;
  IF NOT EXISTS(SELECT 1 FROM sites WHERE id='upgrade-anon' AND edit_token='preserved-anonymous-token') THEN RAISE EXCEPTION 'anonymous credential changed'; END IF;
  IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE id='0009-authorization-cleanup') THEN RAISE EXCEPTION 'missing cleanup marker'; END IF;
END $$;
SQL
for port in "$first_port" "$second_port"; do
  curl -fsS "http://127.0.0.1:$port/s/$site_slug" > "$upgrade_tmp/page"
  grep -q 'Upgrade retained' "$upgrade_tmp/page"
done
docker exec "$pg" psql -U t -d t -v ON_ERROR_STOP=1 -c "DELETE FROM role_bindings WHERE subject_user_id='upgrade-editor'" >/dev/null
docker restart "$first" >/dev/null
first_port=$(docker port "$first" 4300/tcp | awk -F: '{print $NF}')
wait_for_app "$first" "$first_port"
curl --connect-timeout 2 --max-time 15 -fsS "http://127.0.0.1:$first_port/s/$site_slug" > "$upgrade_tmp/page"
grep -q 'Upgrade retained' "$upgrade_tmp/page"
[[ $(docker exec "$pg" psql -U t -d t -Atc "SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('site_members','site_collaborators','site_invites','rbac_migrations')") == 0 ]]
[[ $(docker exec "$pg" psql -U t -d t -Atc "SELECT COUNT(*) FROM role_bindings WHERE subject_user_id='upgrade-editor'") == 0 ]]
echo 'PASS: 0.2.0 runtime -> cleanup; grants imported; both instances serve the artifact; revoked grants and retired schema stay absent after restart.'
