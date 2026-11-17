// Exercise the shipped routes without cookies or bearer credentials, at root or any mount.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

export async function assertAgentDocuments(base, request = fetch) {
  const documents = [
    ["AGENTS.md", "text/markdown", "# Using artifact-site"],
    ["llms.txt", "text/plain", "# artifact-site"],
    ["for-agents.md", "text/markdown", "---\nname:"],
  ];
  const links = new Set();
  for (const [file, type, title] of documents) {
    const url = `${base}/${file}`;
    const response = await request(url, { redirect: "manual", headers: { "accept-language": "zh-CN" } });
    assert.equal(response.status, 200, url);
    assert.equal(response.headers.get("content-type"), `${type}; charset=utf-8`);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("cache-control"), "public, max-age=3600");
    assert.match(response.headers.get("vary"), /host/i);
    assert.match(response.headers.get("vary"), /x-forwarded-proto/i);
    const body = await response.text();
    assert(body.startsWith(title), url);
    assert(body.includes(base), `Missing canonical base in ${file}`);
    assert(!/\{\{BASE_URL\}\}|artifact-site\.example\.com/.test(body), `Unresolved placeholder in ${file}`);
    if (file !== "for-agents.md") {
      for (const match of body.matchAll(/\]\((https?:\/\/[^)]+)\)/g)) {
        assert(match[1].startsWith(`${base}/`), `Link escaped canonical mount: ${match[1]}`);
        links.add(match[1]);
      }
    }
    const head = await request(url, { method: "HEAD", redirect: "manual" });
    assert.equal(head.status, 200, `HEAD ${url}`);
    assert.equal(await head.text(), "");
    for (const name of ["content-type", "cache-control", "vary"]) assert.equal(head.headers.get(name), response.headers.get(name));
  }
  assert(links.size >= 5, "Expected the guide, connection page, CLI and MCP links");
  for (const link of links) {
    const response = await request(link, { redirect: "manual" });
    assert.equal(response.status, 200, `Broken documentation link: ${link}`);
    const fragment = new URL(link).hash.slice(1);
    if (fragment) assert((await response.text()).includes(`id="${fragment}"`), `Missing anchor: ${link}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert(process.argv[2], "Usage: node scripts/test-agent-documents.mjs <base-url>");
  await assertAgentDocuments(process.argv[2]);
  console.log("PASS: anonymous agent documents, GET/HEAD headers, canonical links and anchors");
}
