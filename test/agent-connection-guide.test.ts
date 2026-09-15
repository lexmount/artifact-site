import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AgentConnectionGuide from "@/components/agent-connection-guide";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { guideCommands } from "@/lib/agent-connection-guide";
import { execFileSync } from "node:child_process";

describe("agent connection commands", () => {
  it("quotes the deployment address without shell expansion", () => {
    const base = "https://example.com/$(touch nope)'";
    const c = guideCommands(base);
    const args = execFileSync("bash", ["-c", `artifact-site() { printf '%s' "$3"; }; ${c.login}`], { encoding: "utf8" });
    expect(args).toBe(base);
  });
  it("uses the current server, opts out of public sharing, and emits valid Cursor config", () => {
    const c = guideCommands("https://sites.example:8443");
    expect(c.publish).toContain("--share none");
    expect(c.publish).toContain("https://sites.example:8443");
    expect(JSON.parse(c.cursor).mcpServers["artifact-site"]).toEqual({ url: "https://sites.example:8443/mcp", headers: { Authorization: "Bearer YOUR_TOKEN" } });
    for (const command of [c.install, c.login, c.token, c.publish, c.verify]) {
      expect(() => execFileSync("bash", ["-n"], { input: command })).not.toThrow();
    }
  });
});

it("offers device login only when the deployment has OIDC", () => {
  const render = (oidcEnabled: boolean) => renderToStaticMarkup(createElement(AgentConnectionGuide, { base: "https://sites.example", oidcEnabled }));
  expect(render(true)).toContain("artifact-site login");
  expect(render(false)).not.toContain("artifact-site login");
  expect(render(false)).toContain("ARTIFACT_SITE_TOKEN");
});
it("documents every tool the shipped MCP server registers", () => {
  const source = readFileSync("src/lib/mcp/server.ts", "utf8");
  const html = renderToStaticMarkup(createElement(AgentConnectionGuide, { base: "https://sites.example", oidcEnabled: true }));
  for (const match of source.matchAll(/tool\("([^"]+)", "([^"]+)"/g)) {
    expect(html).toContain(match[1]);
    expect(html).toContain(match[2]);
  }
});

it("encodes a supplied token only in the remote authorization header", () => {
  const config = JSON.parse(guideCommands("https://sites.example", 'secret"token').cursor).mcpServers["artifact-site"];
  expect(config.headers.Authorization).toBe('Bearer secret"token');
  expect(config.url).toBe("https://sites.example/mcp");
  expect(config.command).toBeUndefined();
});

it("installs the source CLI into the global prefix rather than the repository", () => {
  const root = mkdtempSync(path.join(tmpdir(), "guide-install-"));
  try {
    const cli = path.join(root, "cli");
    const prefix = path.join(root, "global");
    mkdirSync(cli);
    const pkg = { name: "guide-install-probe", version: "1.0.0", bin: { "artifact-site": "probe.js" }, scripts: { build: "node -e \"process.exit(0)\"" } };
    writeFileSync(path.join(cli, "package.json"), JSON.stringify(pkg));
    writeFileSync(path.join(cli, "package-lock.json"), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { "": pkg } }));
    writeFileSync(path.join(cli, "probe.js"), "#!/usr/bin/env node\nconsole.log('guide-install-ok')\n", { mode: 0o755 });
    const env = { ...process.env, npm_config_prefix: prefix, npm_config_audit: "false", npm_config_fund: "false", PATH: `${prefix}/bin:${process.env.PATH}` };
    const output = execFileSync("bash", ["-ec", `${guideCommands("https://sites.example").install}\nartifact-site`], { cwd: root, env, encoding: "utf8", timeout: 20000 });
    expect(output).toContain("guide-install-ok");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 25000);

it("offers sign-in from the client first where OIDC exists, and only the token path without it", () => {
  const render = (oidcEnabled: boolean) => renderToStaticMarkup(createElement(AgentConnectionGuide, { base: "https://sites.example", oidcEnabled }));
  const withOidc = render(true);
  expect(withOidc).toContain("Sign in from the client");
  // ChatGPT is told to register dynamically — it works from any network — and when to fall back to the metadata document.
  expect(withOidc).toContain("choose Dynamic Client Registration");
  expect(withOidc).toContain("switch to Dynamic Client Registration");
  const dcrOff = renderToStaticMarkup(createElement(AgentConnectionGuide, { base: "https://sites.example", oidcEnabled: true, dcrEnabled: false }));
  expect(dcrOff).toContain("dynamic registration is turned off on this server");
  expect(dcrOff).not.toContain("choose Dynamic Client Registration");
  // Exactly one panel is rendered: no hidden twin of the token controls, no credential in the config.
  expect(withOidc).not.toContain('id="mcp-access-token"');
  expect(withOidc).not.toContain("Bearer YOUR_TOKEN");
  expect(withOidc).toContain("sites.example/mcp");
  const withoutOidc = render(false);
  expect(withoutOidc).not.toContain("Sign in from the client");
  expect(withoutOidc).toContain('id="mcp-access-token"');
  expect(withoutOidc).toContain("Bearer YOUR_TOKEN");
});

it("shows an editable plaintext token with a separate disabled-until-filled copy action", () => {
  // Without OIDC the token path is the only one, so it is what renders by default.
  const html = renderToStaticMarkup(createElement(AgentConnectionGuide, { base: "https://sites.example", oidcEnabled: false }));
  expect(html).toMatch(/<input[^>]*id="mcp-access-token"[^>]*type="text"/);
  expect(html).toContain('for="mcp-access-token"');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Copy token"/);
});
