#!/usr/bin/env bash
# Exercise the final image with disposable Postgres and content, never a developer's .env/data.
# Usage: E2E_CHROME=/path/to/chrome bash scripts/test-image.sh artifact-site:ci
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
image="${1:-artifact-site:ci}"
suffix="$$"
network="artifact-test-$suffix"
pg="artifact-test-pg-$suffix"
app="artifact-test-app-$suffix"
mkdir -p test-results
cleanup() {
  docker logs "$app" > test-results/image-server.log 2>&1 || true
  docker rm -fv "$app" "$pg" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Inspect what the runtime actually contains, rather than checking Dockerfile text.
docker run --rm --entrypoint node "$image" -e '
  const fs = require("node:fs");
  for (const file of ["LICENSE-APACHE", "LICENSE-MIT", "NOTICE"]) {
    if (!fs.readFileSync(file, "utf8").trim()) throw new Error(`Missing license text: ${file}`);
  }
'
docker network create "$network" >/dev/null
docker run -d --rm --tmpfs /var/lib/postgresql --name "$pg" --network "$network" -p 127.0.0.1::5432 \
  -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test postgres:18-alpine >/dev/null
for i in {1..60}; do
  if docker exec "$pg" pg_isready -U test -d test >/dev/null 2>&1; then break; fi
  if [ "$i" = 60 ]; then echo "Test Postgres did not become ready" >&2; exit 1; fi
  sleep 1
done
port="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
base="http://127.0.0.1:$port"
docker run -d --tmpfs /data --name "$app" --network "$network" -p "127.0.0.1:$port:4300" \
  -e "ARTIFACT_PUBLIC_URL=$base" \
  -e "ARTIFACT_DATABASE_URL=postgres://test:test@$pg:5432/test?sslmode=disable" \
  -e ARTIFACT_CREATE_POLICY=open -e ARTIFACT_DEFAULT_VISIBILITY=public \
  -e ARTIFACT_RATE_LIMIT=off -e PUBLISH_API_TOKEN=image-mcp-acceptance-token "$image" >/dev/null
port="$(docker port "$app" 4300/tcp | awk -F: '{print $NF}')"
base="http://127.0.0.1:$port"
for i in {1..60}; do
  if curl -fsS "$base/" >/dev/null 2>&1; then break; fi
  if [ "$i" = 60 ]; then echo "Test image did not become ready" >&2; exit 1; fi
  sleep 1
done
# curl sends HTTP chunk framing without Content-Length, exercising Next's actual request stream.
code=$(head -c 26000000 /dev/zero | curl --http1.1 --max-time 30 -sS -o /dev/null -w '%{http_code}' \
  -H 'Transfer-Encoding: chunked' -H 'Content-Type: application/json' \
  --data-binary @- "$base/api/sites" || true)
[ "$code" = 413 ] || { echo "Expected 413 for oversized chunked body, got $code" >&2; exit 1; }
npm --prefix cli ci
npm --prefix cli run build
VIEWER_E2E_URL="$base" MCP_E2E_URL="$base" MCP_E2E_TOKEN=image-mcp-acceptance-token npx vitest run test/document-viewer.e2e.test.ts test/agent-guide.e2e.test.ts test/official-version.e2e.test.ts test/remote-mcp.integration.test.ts

# Seed identities only in this disposable database, then exercise real role-aware browser pages.
pg_port="$(docker port "$pg" 5432/tcp | awk -F: '{print $NF}')"
RBAC_E2E_ADMIN_TOKEN=image-mcp-acceptance-token RBAC_E2E_URL="$base" ARTIFACT_DB_DRIVER=postgres ARTIFACT_DATABASE_URL="postgres://test:test@127.0.0.1:$pg_port/test?sslmode=disable" npx vitest run test/rbac.e2e.test.ts
