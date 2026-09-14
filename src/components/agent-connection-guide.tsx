"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ClipboardCopy, Link2, UserRound } from "lucide-react";
import Link from "next/link";
import TokenCreate from "@/components/token-create";
import { useAuth } from "@/lib/use-auth";
import { mcpTools as tools } from "@/lib/mcp-tools";
import CommandBlock from "@/components/command-block";
import { useT } from "@/components/locale-provider";
import { guideCommands } from "@/lib/agent-connection-guide";

const modes = ["agent", "cli", "mcp"] as const;
type Mode = typeof modes[number];


function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return <section className="connection-step"><h2><span aria-hidden="true">{number}</span>{title}</h2><div>{children}</div></section>;
}

export default function AgentConnectionGuide({ base, oidcEnabled }: { base: string; oidcEnabled: boolean }) {
  const t = useT();
  const [mode, setMode] = useState<Mode>("agent");
  const [auth, setAuth] = useState<"login" | "token">(oidcEnabled ? "login" : "token");
  const [token, setToken] = useState("");
  const [copyResult, setCopyResult] = useState<{ token: string; status: "copied" | "failed" } | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  async function copyToken() {
    if (!token.trim()) return;
    if (copyTimer.current) clearTimeout(copyTimer.current);
    try {
      await navigator.clipboard.writeText(token);
      setCopyResult({ token, status: "copied" });
      copyTimer.current = setTimeout(() => setCopyResult(null), 1600);
    } catch { setCopyResult({ token, status: "failed" }); }
  }
  const tokenCopyStatus = copyResult?.token === token ? copyResult.status : null;
  const { user } = useAuth();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const c = guideCommands(base, token || "YOUR_TOKEN");
  useEffect(() => {
    const sync = () => { const hash = window.location.hash.slice(1); if (modes.includes(hash as Mode)) setMode(hash as Mode); };
    sync(); window.addEventListener("popstate", sync);
    return () => { window.removeEventListener("popstate", sync); };
  }, []);
  function choose(next: Mode) { if (next === mode) return; setMode(next); window.history.pushState(null, "", `#${next}`); }
  function navigate(event: KeyboardEvent, index: number) {
    const next = event.key === "ArrowRight" ? (index + 1) % modes.length : event.key === "ArrowLeft" ? (index + modes.length - 1) % modes.length : event.key === "Home" ? 0 : event.key === "End" ? modes.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); choose(modes[next]); tabs.current[next]?.focus();
  }
  const labels = [t("Hand to an agent"), t("Command-line CLI"), t("MCP connection")];
  const command = (value: string) => <CommandBlock command={value} copyLabel={t("Copy command")} />;
  const install = <details className="connection-install"><summary>{t("View installation steps")}</summary><p>{t("Requires Node 24+ and npm. Run these commands from the artifact-site source repository root on the machine running your CLI or agent. The npm package is not published yet.")}</p>{command(c.install)}<p>{t("If artifact-site is not found, check npm's global bin directory is on PATH, then restart your terminal or agent client. If npm link reports EACCES, use a user-writable npm prefix; see the CLI README for commands.")}</p></details>;
  const authContent = <>
    {oidcEnabled ? <div className="connection-auth" role="group" aria-label={t("Authentication method")}><button type="button" aria-pressed={auth === "login"} onClick={() => setAuth("login")}>{t("Browser sign-in")}</button><button type="button" aria-pressed={auth === "token"} onClick={() => setAuth("token")}>{t("Use a token")}</button></div> : <p className="connection-note">{t("Browser sign-in is not configured on this server. Search, read and site details work without a token where access permits. Publishing, updating, sharing and deleting require a token in the current CLI/MCP client. The default local setup issues no credentials: use browser uploads or the agent publishing guide, or ask the operator to configure OIDC or PUBLISH_API_TOKEN for authenticated use.")}</p>}
    {auth === "login" && oidcEnabled ? <>{command(c.login)}<p>{t("Open the verification page, sign in and approve the session you started. The CLI saves this personal credential on this machine.")}</p></> : <>{command(c.token)}<p>{t("Works in Bash and zsh. Paste the token at the hidden prompt; it is not written into the command history. Environment credentials override saved credentials. Never paste a token into chat or commit it to a repository.")}</p><p>{t("Operator tokens have broad privileges and cannot list personal sites. Verify an operator token by publishing a test file; whoami has no personal identity to display.")}</p></>}
  </>;
  return <div className="connection-guide">
    <div className="connection-tabs" role="tablist" aria-label={t("Connection method")}>
      {modes.map((id, index) => <button type="button" key={id} id={`tab-${id}`} ref={(el) => { tabs.current[index] = el; }} role="tab" aria-selected={mode === id} aria-controls={id} tabIndex={mode === id ? 0 : -1} onKeyDown={(e) => navigate(e, index)} onClick={() => choose(id)}>{labels[index]}{index === 0 && <small>{t("Recommended")}</small>}</button>)}
    </div>
    <section id="agent" role="tabpanel" aria-labelledby="tab-agent" hidden={mode !== "agent"} tabIndex={0}>
      <CommandBlock size="large" command={t("Publish this project's output (a web page or a PDF/Office document) to artifact-site. Publishing guide: {url}", { url: `${base}/for-agents.md` })} />
      <p className="hint">{t("Works with Claude Code, Cursor, Codex and other assistants that can read a URL.")}</p>
      <ol className="steps">{[
        { icon: ClipboardCopy, title: t("Copy the line"), text: t("Send it to the agent you are working in.") },
        { icon: UserRound, title: t("Approve once"), text: t("If it asks to sign in, approve the terminal session you started yourself.") },
        { icon: Link2, title: t("View and share"), text: t("Open the published work and choose who can access it.") },
      ].map(({ icon: Icon, title, text }) => <li key={title}><Icon size={28} strokeWidth={1.7} aria-hidden="true" /><strong>{title}</strong><p>{text}</p></li>)}</ol>
      <div className="connection-capabilities"><h2>{t("Keep working after publishing")}</h2><p>{t("Ask the agent to update a site, search previous work or read its text. It follows the server's publishing and access policies.")}</p></div>
    </section>
    <section id="cli" role="tabpanel" aria-labelledby="tab-cli" hidden={mode !== "cli"} tabIndex={0}>
      <p className="connection-server">{t("Current server")} <code>{base}</code></p>
      <Step number={1} title={t("Install the CLI")}><p>{t("The CLI provides all operations from your terminal. MCP connects remotely without installing it.")}</p>{install}</Step>
      <Step number={2} title={t("Authenticate")}>{authContent}</Step>
      <Step number={3} title={t("Publish and verify")}>{command(auth === "login" ? `${c.verify}\n${c.publish}` : c.publish)}<p>{t("Replace dist/ with your build output. A successful publish returns the site address. This example creates no share link; omitting --share defaults to a public share.")}</p></Step>
      <details><summary>{t("Update, search and read commands")}</summary>{command(c.more)}<p>{t("Replace YOUR_SITE_SLUG with the identifier in the site's address. Update writes a new version; search and read respect your access permissions.")}</p></details>
    </section>
    <section id="mcp" role="tabpanel" aria-labelledby="tab-mcp" hidden={mode !== "mcp"} tabIndex={0}>
      <p className="connection-note">{t("Connect directly to this server over HTTP. No Node.js, CLI installation or local MCP process is needed.")}</p>
      <Step number={1} title={t("MCP server address")}>{command(c.endpoint)}</Step>
      <Step number={2} title={t("Authorize your agent")}>
        <p>{t("Use a personal token to act with your account permissions. Create one below or paste an existing token. Tokens stay in this page's memory and are never saved by this page.")}</p>
        {user ? <TokenCreate onCreated={setToken} /> : <p>{t("Sign in to create a personal token. Without browser sign-in, ask the operator for a configured token; it has administrator privileges.")}</p>}
        <label htmlFor="mcp-access-token">{t("Access token")}</label>
        <div className="connection-token-value">
          <input id="mcp-access-token" className="field" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} value={token} onChange={(event) => setToken(event.target.value)} />
          <button type="button" className="btn" disabled={!token.trim()} aria-label={t("Copy token")} onClick={copyToken}>{tokenCopyStatus === "copied" ? t("Copied") : t("Copy token")}</button>
        </div>
        <span className="connection-copy-status" role="status">{tokenCopyStatus === "copied" ? t("Copied") : ""}</span>
        {tokenCopyStatus === "failed" && <p role="alert">{t("Could not copy automatically. Select the token and copy it manually.")}</p>}
        <p>{t("Copy the configuration before leaving. Manage and revoke personal tokens in My sites.")} <Link href="/me">{t("My sites")}</Link></p>
      </Step>
      <Step number={3} title={t("Copy MCP configuration")}>
        <CommandBlock command={c.cursor} copyLabel={t("Copy configuration")} disabled={!token.trim()} />
        <p>{t("The configuration contains your token. Keep it in your client's private user settings, outside repositories. If your client asks for separate fields, use the server address and Authorization: Bearer token.")}</p>
        <details><summary>{t("Client-specific instructions")}</summary><p>{t("For Cursor, merge this entry into mcpServers in ~/.cursor/mcp.json. Other clients may use different configuration keys; choose Streamable HTTP and supply the same Authorization header.")}</p></details>
      </Step>
      <Step number={4} title={t("Verify the connection")}><p>{t("Reload the client and check that 15 tools are available. Ask “What artifacts have I published?” without naming MCP. Then publish a test file, read it back and delete it. Use artifact_site_connection to diagnose identity or limits.")}</p></Step>
      <div className="connection-capabilities"><h2>{t("Available tools")}</h2><p>{t("Publish and update · Search and read · List and share")}</p>
        <details><summary>{t("All tools and parameters")}</summary><p>{t("Your MCP client discovers each tool's parameter schema automatically. Export, rollback and delete are also available; confirm destructive actions before use.")}</p><dl className="connection-tools">{tools.map(([name, label]) => <div key={name}><dt><code>{name}</code></dt><dd>{t(label)}</dd></div>)}</dl><p>{t("The artifact-site://skill resource provides the publishing contract and runtime limits. Full HTTP API details remain in the publishing guide below.")}</p></details>
      </div>
    </section>
  </div>;
}
