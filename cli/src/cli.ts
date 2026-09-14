// `artifact-site` command line. Thin: argument parsing, output formatting, exit codes. All real
// work is in client.ts / publish.ts / login.ts shared by all CLI commands.
import { readFile, writeFile } from "node:fs/promises";
import { Command, InvalidArgumentError } from "commander";
import { ApiError, ArtifactSiteClient, type Me, type SharePolicy } from "./client.js";
import { clearToken, readStoredConfig, readToken, resolveBaseUrl, writeStoredConfig } from "./config.js";
import { loginStart, loginWait } from "./login.js";
import { mb, publishHtml, publishPath, updateFromPath } from "./publish.js";

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Read all of stdin (for `publish -` ). */
  stdin: () => Promise<string>;
  openUrl?: (url: string) => Promise<void>;
}

const defaultIo: Io = {
  out: (l) => process.stdout.write(l + "\n"),
  err: (l) => process.stderr.write(l + "\n"),
  stdin: async () => {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  },
  openUrl: async (url) => {
    // The URL comes from the server. Only ever hand an http(s) URL to the OS opener, and never
    // through a shell (cmd.exe would interpret metacharacters in it).
    let parsed: URL;
    try { parsed = new URL(url); } catch { return; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    const { spawn } = await import("node:child_process");
    const [cmd, args] = process.platform === "darwin" ? ["open", [parsed.href]]
      : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", parsed.href]]
      : ["xdg-open", [parsed.href]];
    await new Promise<void>((resolve) => { const p = spawn(cmd, args, { stdio: "ignore", detached: true, shell: false }); p.on("error", () => resolve()); p.unref(); resolve(); });
  },
};

export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) { super(message); this.name = "CliError"; }
}

const POLICIES: SharePolicy[] = ["public", "login", "email", "passcode"];
function parsePolicy(v: string): SharePolicy | false {
  if (v === "none" || v === "false" || v === "off") return false;
  if ((POLICIES as string[]).includes(v)) return v as SharePolicy;
  throw new InvalidArgumentError(`policy must be one of ${POLICIES.join(", ")} or none`);
}

export function buildProgram(io: Io = defaultIo, makeClient: (base: string, token: string | null) => ArtifactSiteClient = (baseUrl, token) => new ArtifactSiteClient({ baseUrl, token })): Command {
  const program = new Command("artifact-site")
    .description("Manage your remote Artifact Site library of pages, reports, charts and documents: find previous work, read it, publish updates and share links.")
    .option("--base <url>", "artifact-site base URL (or ARTIFACT_SITE_URL / the stored config)")
    .option("--json", "machine-readable output")
    .configureOutput({ writeOut: (s) => io.out(s.replace(/\n$/, "")), writeErr: (s) => io.err(s.replace(/\n$/, "")) })
    .exitOverride()
    .addHelpText("after", `
Common tasks:
  artifact-site login --base https://your-server
  artifact-site find                              # my published artifacts
  artifact-site find quarterly report             # search discoverable work
  artifact-site read YOUR_SLUG                     # read a report
  artifact-site publish dist/ --share none         # upload a new artifact
  artifact-site update YOUR_SLUG --title "Report"  # rename only
  artifact-site info YOUR_SLUG                     # version and file names

Use --json for agents/scripts and <command> --help for options.
For remote MCP, connect to https://your-server/mcp; no local MCP command is needed.`);

  const json = () => Boolean(program.opts().json);
  const base = (): string => {
    const b = resolveBaseUrl(program.opts().base);
    if (!b) throw new CliError("No base URL: pass --base https://your-artifact-site, set ARTIFACT_SITE_URL, or run `artifact-site login --base <url>` once", 2);
    return b;
  };
  const client = (requireAuth = true): ArtifactSiteClient => {
    const b = base();
    const token = readToken(b);
    if (requireAuth && !token) throw new CliError("Not signed in: run `artifact-site login` (or set ARTIFACT_SITE_TOKEN)", 3);
    return makeClient(b, token);
  };
  const emit = (data: unknown, human: () => void) => { if (json()) io.out(JSON.stringify(data, null, 2)); else human(); };

  program.command("login")
    .description("Sign in once on this machine (device authorisation in the browser); stores the publish token")
    .option("--no-open", "do not try to open the browser")
    .action(async (opts: { open: boolean }) => {
      const c = client(false);
      const start = await loginStart(c);
      io.out(start.user_message);
      if (opts.open && io.openUrl) await io.openUrl(start.verification_url).catch(() => {});
      io.err("Waiting for you to click Allow…");
      const { email } = await loginWait(c, start, { onPoll: () => io.err(".") });
      writeStoredConfig({ baseUrl: c.baseUrl, email });
      emit({ signedIn: true, email, baseUrl: c.baseUrl }, () => io.out(`Signed in as ${email ?? "(unknown email)"} on ${c.baseUrl}. Token stored.`));
    });

  program.command("logout").description("Forget the stored token for this server").action(async () => {
    clearToken(base());
    emit({ signedIn: false }, () => io.out("Token removed."));
  });

  program.command("whoami").description("Check the connected account and server; credentials are already stored after login").action(async () => {
    const c = client(false);
    // A refused token is the answer, not an error: the server says whether it is unknown here
    // (issued by another deployment — sign in on this one, the other token is untouched) or revoked.
    let me: Me = { user: null, oidcEnabled: false };
    let refusal: string | null = null;
    if (c.authenticated) {
      try { me = await c.me(); }
      catch (e) {
        if (e instanceof ApiError && e.status === 401) refusal = e.code ?? "token_rejected"; else throw e;
      }
    }
    emit({ baseUrl: c.baseUrl, user: me.user, email: readStoredConfig().email, tokenStatus: me.user ? "ok" : refusal ?? (c.authenticated ? "rejected" : "none") }, () => {
      io.out(`base: ${c.baseUrl}`);
      if (me.user) io.out(`signed in as ${me.user.email ?? me.user.id}`);
      else if (refusal === "token_unknown") io.out("the stored token is not known to this server (it was issued by another deployment): run `artifact-site login --base " + c.baseUrl + "`");
      else if (refusal === "token_revoked") io.out("the stored token was revoked: run `artifact-site login` again");
      else if (c.authenticated) io.out("token present but not recognised by the server");
      else io.out("not signed in");
    });
  });

  program.command("publish")
    .description("Publish a file (.html / pdf / pptx / docx / .zip), a directory, or HTML from stdin (`-`) as a new site")
    .argument("<path>", "file, directory, or - for stdin")
    .option("-t, --title <title>", "site title")
    .option("-s, --share <policy>", "share link to create: public (default), login, email, passcode, or none", parsePolicy, "public")
    .action(async (target: string, opts: { title?: string; share: SharePolicy | false }) => {
      const c = client();
      const progress = json() ? undefined : (l: string) => io.err(l);
      const out = target === "-"
        ? await publishHtml(c, await io.stdin(), { title: opts.title, share: opts.share })
        : await publishPath(c, target, { title: opts.title, share: opts.share, onProgress: progress });
      emit({ slug: out.site.slug, kind: out.site.kind, title: out.site.title, siteUrl: out.siteUrl, readerUrl: out.readerUrl, share: out.share ?? null, shareError: out.shareError, route: out.route }, () => {
        io.out(`Published ${out.site.title} (${out.site.kind}, slug ${out.site.slug})`);
        io.out(`  site:  ${out.siteUrl}`);
        if (out.share) io.out(`  share: ${out.share.url}${out.share.passcode ? `  (passcode ${out.share.passcode})` : ""}  ← give this one to readers`);
        if ("notice" in out.site && out.site.notice) io.err(`note: ${out.site.notice}`);
      });
      if (out.shareError) throw new CliError(`The site was created but the share link was not: ${out.shareError}. Create one with: artifact-site share ${out.site.slug}`, 5);
    });

  program.command("update")
    .description("Replace a remote artifact's full contents, or rename it with --title and no path")
    .argument("<slug>", "remote artifact identifier").argument("[path]", "replacement local file or directory; omit for title-only changes")
    .option("-t, --title <title>", "rename only; cannot be combined with a path")
    .option("--expected-version <id>", "reject concurrent changes; get this ID from info or export")
    .action(async (slug: string, target: string | undefined, opts: { title?: string; expectedVersion?: string }) => {
      if (!target) {
        if (!opts.title?.trim() || opts.expectedVersion) throw new CliError("Without a path, supply --title and no --expected-version", 2);
        const r = await client().rename(slug, opts.title);
        emit(r, () => io.out(`Renamed ${slug} to ${r.title}`)); return;
      }
      if (opts.title !== undefined) throw new CliError("Use update with either a path or --title, not both", 2);
      const c = client();
      const r = await updateFromPath(c, slug, target, { expectedVersion: opts.expectedVersion, onProgress: json() ? undefined : (l) => io.err(l) });
      emit({ slug: r.slug, kind: r.kind, versionId: r.versionId, siteUrl: c.absolute(r.url) }, () => io.out(`Updated ${r.slug}: new version ${r.versionId}`));
    });

  program.command("edit")
    .description("Replace one remote text file, preserving other files; read it first and supply its version")
    .argument("<slug>").argument("<path>", "local UTF-8 file, or - for stdin")
    .requiredOption("--file <relpath>", "remote relative filename from info, such as index.html")
    .requiredOption("--expected-version <id>", "version read before editing; conflicts exit 4")
    .action(async (slug: string, target: string, opts: { file: string; expectedVersion: string }) => {
      const content = target === "-" ? await io.stdin() : await readFile(target, "utf8");
      const c = client(); const site = await c.getSite(slug);
      if (site.kind === "single" && !site.files.includes(opts.file)) throw new CliError("--file must name the single page shown by info", 2);
      const result = await c.edit(slug, { ...(site.kind === "single" ? {} : { path: opts.file }), content }, opts.expectedVersion);
      emit(result, () => io.out(`Edited ${slug}/${opts.file}: new version ${result.versionId}`));
    });

  program.command("fork").description("Copy a remote artifact into a new independent artifact, leaving its source unchanged")
    .argument("<slug>").action(async (slug: string) => {
      const c = client(); const result = await c.fork(slug);
      emit(result, () => io.out(`Copied ${slug}: ${c.absolute(result.url)}`));
    });

  const listMine = async () => {
    const c = client();
    const r = await c.mySites();
    emit(r, () => {
      const row = (s: { slug: string; title: string; kind: string; visibility?: string }) => `  ${s.slug.padEnd(14)} ${s.kind.padEnd(9)} ${(s.visibility ?? "").padEnd(9)} ${s.title}`;
      io.out(`owned (${r.owned.length}):`); r.owned.forEach((s) => io.out(row(s)));
      if (r.collaborating.length) { io.out(`can edit (${r.collaborating.length}):`); r.collaborating.forEach((s) => io.out(row(s))); }
    });
  };
  program.command("list", { hidden: true }).description("Compatibility alias: use find without keywords").action(listMine);

  program.command("info").description("Inspect a remote artifact: kind, current version, files and history; optionally sharing records").argument("<slug>").option("--shares", "include share summaries (requires owner permission)").action(async (slug: string, opts: { shares?: boolean }) => {
    const c = client(Boolean(opts.shares));
    const [info, versions] = await Promise.all([c.getSite(slug), c.listVersions(slug)]);
    const shares = opts.shares ? await c.listShares(slug) : undefined;
    emit({ ...info, ...shares, content: undefined, currentVersionId: versions.currentVersionId, versions: versions.versions }, () => {
      io.out(`${info.title} — ${info.kind} — ${c.absolute(info.url)}`);
      io.out(`current version: ${versions.currentVersionId}  (${versions.versions.length} in history)`);
      if (shares) io.out(`share records: ${shares.shares.length} (secret links are not returned)`);
      io.out(`files (${info.files.length}): ${info.files.slice(0, 20).join(", ")}${info.files.length > 20 ? ", …" : ""}`);
    });
  });

  const search = async (words: string[], opts: { limit?: number }) => {
    const c = client(false);
    const r = await c.search(words.join(" "), opts.limit);
    emit({ query: r.query, results: r.results.map((s) => ({ ...s, url: c.absolute(s.url) })) }, () => {
      if (!r.results.length) { io.out("no matches"); return; }
      for (const s of r.results) {
        io.out(`${s.slug}  ${s.kind.padEnd(8)} ${(s.visibility ?? "").padEnd(8)} ${s.title}`);
        io.out(`    ${s.snippet}`);
      }
    });
  };
  const resultLimit = (value: string) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new InvalidArgumentError("limit must be an integer from 1 to 50");
    return n;
  };
  program.command("find").description("Show my remote artifacts; with keywords, search discoverable pages, reports and documents")
    .argument("[query...]", "omit for owned/collaborative works; keywords search titles and contents, including public works")
    .option("-n, --limit <n>", "keyword search result limit (default 10, max 50; ignored without keywords)", resultLimit)
    .action(async (words: string[], opts: { limit?: number }) => {
      if (words.length) return search(words, opts);
      return listMine();
    });
  program.command("search", { hidden: true }).description("Compatibility alias: use find <keywords>")
    .argument("<query...>").option("-n, --limit <n>", "maximum results (1-50)", resultLimit).action(search);

  program.command("read").description("Read a remote report/document for summarizing or reuse; --file reads one original text file")
    .argument("<slug>").option("-f, --file <relpath>", "one file of the tree, verbatim (text types only)")
    .option("--max-chars <n>", "cut the text after this many characters (default 20000)", (v) => Number(v))
    .action(async (slug: string, opts: { file?: string; maxChars?: number }) => {
      const c = client(false);
      const r = await c.readText(slug, { file: opts.file, maxChars: opts.maxChars });
      emit({ ...r, url: c.absolute(r.url) }, () => {
        io.out(r.text);
        if (r.truncated) io.err(`(truncated: ${r.chars} characters in total; raise --max-chars to see more)`);
      });
    });

  program.command("share")
    .description("Create a share link for a site")
    .argument("<slug>")
    .option("-p, --policy <policy>", "public | login | email | passcode", (v) => { const p = parsePolicy(v); if (!p) throw new InvalidArgumentError("policy is required"); return p; }, "public")
    .option("-l, --label <label>", "a label to tell links apart")
    .option("--expires <days>", "7, 30 or 90", (v) => { const n = Number(v); if (![7, 30, 90].includes(n)) throw new InvalidArgumentError("expires must be 7, 30 or 90"); return n; })
    .option("--passcode <code>", "choose the passcode (policy passcode); omitted = generated")
    .action(async (slug: string, opts: { policy: SharePolicy; label?: string; expires?: number; passcode?: string }) => {
      const r = await client().createShare(slug, { policy: opts.policy, label: opts.label, expiresInDays: opts.expires, passcode: opts.passcode });
      emit(r, () => io.out(`${r.url}${r.passcode ? `  (passcode ${r.passcode})` : ""}`));
    });

  program.command("export").description("Download the current version as a zip; prints the version id for --expected-version")
    .argument("<slug>").option("-o, --out <file>", "output file (default <slug>.zip)")
    .action(async (slug: string, opts: { out?: string }) => {
      const { zip, versionId } = await client().export(slug);
      const file = opts.out ?? `${slug}.zip`;
      await writeFile(file, zip);
      emit({ slug, versionId, file, bytes: zip.byteLength }, () => io.out(`${file} (${mb(zip.byteLength)}), version ${versionId}`));
    });

  program.command("rollback").description("Restore an earlier version as the current one").argument("<slug>").argument("<versionId>")
    .action(async (slug: string, versionId: string) => { const r = await client().rollback(slug, versionId); emit(r, () => io.out(`Rolled back ${slug}: new version ${r.versionId}`)); });

  program.command("rename", { hidden: true }).description("Change a site's title").argument("<slug>").argument("<title>")
    .action(async (slug: string, title: string) => { const r = await client().rename(slug, title); emit(r, () => io.out(`Renamed ${slug} to ${r.title}`)); });

  program.command("delete").description("Delete a site you own").argument("<slug>")
    .action(async (slug: string) => { const r = await client().delete(slug); emit(r, () => io.out(`Deleted ${slug}`)); });

  program.command("skill").description("Print the platform's publishing guide for agents (/for-agents.md)")
    .action(async () => io.out(await client(false).skill()));

  return program;
}

/** Run with argv; returns the exit code instead of exiting, so tests can drive it. */
export async function run(argv: string[], io: Io = defaultIo, makeClient?: (base: string, token: string | null) => ArtifactSiteClient): Promise<number> {
  const program = buildProgram(io, makeClient);
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CliError) { io.err(error.message); return error.exitCode; }
    if (error instanceof ApiError) {
      io.err(`error ${error.status}: ${error.message}${error.currentVersionId ? ` (current version ${error.currentVersionId} — export again and retry)` : ""}`);
      return error.status === 401 ? 3 : error.status === 409 ? 4 : 1;
    }
    const e = error as { code?: string; exitCode?: number; message?: string };
    if (e.code === "commander.helpDisplayed" || e.code === "commander.version") return 0;
    if (typeof e.code === "string" && e.code.startsWith("commander.")) return 2; // usage error, whatever commander's own code
    io.err(e.message ?? String(error));
    return 1;
  }
}
