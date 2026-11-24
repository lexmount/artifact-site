import { installSkill, skillDirectory } from "./skill-package.js";
import { readSkillDocs } from "./skill-docs.js";
import { registerRecordCommands } from "./record-commands.js";
// `artifact-site` command line. Thin: argument parsing, output formatting, exit codes. All real
// work is in client.ts / publish.ts / login.ts shared by all CLI commands.
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { Command, InvalidArgumentError } from "commander";
import { ApiError, ArtifactSiteClient, type Me, type SharePolicy, type DataPublication } from "./client.js";
import { clearToken, readToken, resolveBaseUrl, writeStoredConfig } from "./config.js";
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

const POLICIES: SharePolicy[] = ["public", "login", "people", "email", "passcode"];
function parsePolicy(v: string): SharePolicy | false {
  if (v === "email") return "people";
  if (v === "none" || v === "false" || v === "off") return false;
  if ((POLICIES as string[]).includes(v)) return v as SharePolicy;
  throw new InvalidArgumentError(`policy must be one of ${POLICIES.join(", ")} or none`);
}

/** The package's own version, for `--version` — read from package.json so it cannot drift from what npm published. */
function packageVersion(): string {
  try {
    return String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  } catch {
    return "unknown";
  }
}

export function buildProgram(io: Io = defaultIo, makeClient: (base: string, token: string | null) => ArtifactSiteClient = (baseUrl, token) => new ArtifactSiteClient({ baseUrl, token, channel: "cli" })): Command {
  const program = new Command("artifact-site")
    .version(packageVersion(), "-v, --version", "print the CLI version")
    .description("Manage your remote Artifact Site library of pages, reports, charts and documents: find previous work, read it, publish updates and share links.")
    .option("--base <url>", "artifact-site base URL (or ARTIFACT_SITE_URL / the stored config)")
    .option("--tenant <id>", "destination tenant (or ARTIFACT_SITE_TENANT)")
    .option("--share-token <token>", "share context (or ARTIFACT_SITE_SHARE_TOKEN)")
    .option("--json", "machine-readable output")
    .configureOutput({ writeOut: (s) => io.out(s.replace(/\n$/, "")), writeErr: (s) => io.err(s.replace(/\n$/, "")) })
    .exitOverride()
    .addHelpText("after", `
Common tasks:
  artifact-site login --base https://your-server
  artifact-site find                              # my published artifacts
  artifact-site find quarterly report             # mixed results, labeled by relationship
  artifact-site find --public                     # explicitly browse the public catalog
  artifact-site folders list                      # my folder IDs and names
  artifact-site move YOUR_SLUG --folder FOLDER_ID   # file an existing artifact
  artifact-site read YOUR_SLUG                     # read a report
  artifact-site publish dist/ --share none         # upload a new artifact
  artifact-site update YOUR_SLUG --title "Report"  # rename only
  artifact-site comments list YOUR_SLUG --json     # read feedback before revising
  artifact-site info YOUR_SLUG                     # version and file names

Use --json for agents/scripts and <command> --help for options.
For MCP, connect to https://your-server/mcp directly, or run "artifact-site mcp" for a local stdio server.`);

  const json = () => Boolean(program.opts().json);
  const base = (): string => {
    const b = resolveBaseUrl(program.opts().base);
    if (!b) throw new CliError("No base URL: pass --base https://your-artifact-site, set ARTIFACT_SITE_URL, or run `artifact-site login --base <url>` once", 2);
    return b;
  };
  const client = (requireAuth = true): ArtifactSiteClient => {
    const b = base();
    const token = readToken(b);
    if (requireAuth && !token) throw new CliError("This CLI has no personal credential: run `artifact-site login` (or set ARTIFACT_SITE_TOKEN). Browser sign-in does not authenticate the CLI.", 3);
    return makeClient(b, token).setContext({tenantId:program.opts().tenant ?? process.env.ARTIFACT_SITE_TENANT,shareToken:program.opts().shareToken ?? process.env.ARTIFACT_SITE_SHARE_TOKEN});
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
    emit({ baseUrl: c.baseUrl, user: me.user, email: me.user?.email ?? null, operator: me.operator ?? false, tokenStatus: me.user ? "ok" : me.operator ? "operator" : refusal ?? (c.authenticated ? "unidentified" : "none") }, () => {
      io.out(`base: ${c.baseUrl}`);
      if (me.user) io.out(`signed in as ${me.user.email ?? me.user.id}`);
      else if (me.operator) io.out("operator credential: connected, but no personal account or folder library");
      else if (refusal === "token_unknown") io.out("the stored token is not known to this server (it was issued by another deployment): run `artifact-site login --base " + c.baseUrl + "`");
      else if (refusal === "token_revoked") io.out("the stored token was revoked: run `artifact-site login` again");
      else if (c.authenticated) io.out("no personal account identified; older servers may not identify operator credentials");
      else io.out("this CLI is not signed in; browser sign-in is separate");
    });
  });

  const publicationData = async (opts: { dataContract?: string; dataCollections?: string; dataChanges?: string }): Promise<DataPublication> => {
    const result: DataPublication = {};
    try {
      if (opts.dataCollections) result.dataCollections = JSON.parse(await readFile(opts.dataCollections, "utf8"));
      if (opts.dataContract) result.dataContract = JSON.parse(await readFile(opts.dataContract, "utf8"));
      if (opts.dataChanges) result.dataChanges = JSON.parse(await readFile(opts.dataChanges, "utf8"));
    } catch { throw new CliError("Data contract and data changes must be readable JSON files", 2); }
    return result;
  };

  program.command("publish")
    .option("--data-collections <file>", "JSON collection definitions; omit to inherit, empty object disables without deleting records")
    .option("--data-contract <file>", "JSON file mapping dataset names to schemas; omission preserves the current contract")
    .option("--data-changes <file>", "JSON array of name, expectedRevision, value changes committed with the code")
    .option("--operation-key <key>", "publication identity; reuse to recover, change to publish another copy")
    .option("--official", "designate the uploaded version as the only official version")
    .description("Publish a file, a directory, an archive, or HTML from stdin (`-`) as a new work")
    .argument("<path>", "file, directory, or - for stdin")
    .option("-t, --title <title>", "site title")
    .option("-s, --share <policy>", "deprecated advanced share: public, login, email, passcode, or none (default); creates an independent discussion", parsePolicy, false)
    .action(async (target: string, opts: { dataContract?: string; dataCollections?: string; dataChanges?: string; operationKey?: string; official?: boolean; title?: string; share: SharePolicy | false }) => {
      const c = client();
      const progress = json() ? undefined : (l: string) => io.err(l);
      const out = target === "-"
        ? await publishHtml(c, await io.stdin(), { ...await publicationData(opts), operationKey: opts.operationKey, official: opts.official, title: opts.title, share: opts.share })
        : await publishPath(c, target, { ...await publicationData(opts), operationKey: opts.operationKey, official: opts.official, title: opts.title, share: opts.share, onProgress: progress });
      emit({ moderation: out.site.moderation, officialVersionId: out.site.officialVersionId, officialRevision: out.site.officialRevision, visibility: out.site.visibility, slug: out.site.slug, kind: out.site.kind, title: out.site.title, siteUrl: out.siteUrl, readerUrl: out.readerUrl, share: out.share ?? null, shareError: out.shareError, route: out.route }, () => {
        io.out(`${(out.share?.moderation || out.site.moderation) ? "Saved for review" : "Published"} ${out.site.title} (${out.site.kind}, slug ${out.site.slug})`);
        io.out(`  site:  ${out.siteUrl}`);
        io.out(`  access: ${out.site.visibility ?? "unknown"} (copying does not change access)`);
        if (out.share?.moderation || out.site.moderation) io.out(`  review: ${(out.share?.moderation ?? out.site.moderation)!.requestId} — pending; this version is not yet shared`);
        if (out.share?.moderation && out.share.passcode) io.out(`  passcode: ${out.share.passcode} — save now; shown only once`);
        if (out.share?.url) io.out(`  share: ${out.share.url}${out.share.passcode ? `  (passcode ${out.share.passcode})` : ""}  ← give this one to readers`);
        if ("notice" in out.site && out.site.notice) io.err(`note: ${out.site.notice}`);
      });
      if (out.shareError) throw new CliError(`The site was created but the share link was not: ${out.shareError}. Create one with: artifact-site share ${out.site.slug}`, 5);
    });

  program.command("visibility").description("Inspect or change main-link access; independent links are unchanged")
    .argument("<slug>").argument("[state]", "private | unlisted (link access, not discoverable) | public (discoverable)")
    .action(async (slug: string, state?: string) => {
      if (state && !["private", "unlisted", "public"].includes(state)) throw new CliError("state must be private, unlisted or public", 2);
      const c = client();
      const result = state ? await c.setVisibility(slug, state as "private" | "unlisted" | "public") : await c.getVisibility(slug);
      emit(result, () => { const pending = (result as {moderation?: {pending?:boolean;requestId?:string}}).moderation; if (pending?.pending) io.out(`Opening request pending: ${pending.requestId}`); io.out(`${result.visibility}: ${c.absolute(result.url)}`); if (state === "private") io.out("Independent share links are not revoked."); });
    });

  program.command("update")
    .option("--data-collections <file>", "JSON collection definitions; omit to inherit, empty object disables without deleting records")
    .option("--data-contract <file>", "JSON file mapping dataset names to schemas; omission preserves the current contract")
    .option("--data-changes <file>", "JSON array of name, expectedRevision, value changes committed with the code")
    .option("--operation-key <key>", "update identity; reuse to recover, change for a new operation")
    .option("--official", "designate the uploaded version as the only official version")
    .description("Replace a remote artifact's full contents, or rename it with --title and no path")
    .argument("<slug>", "remote artifact identifier").argument("[path]", "replacement local file or directory; omit for title-only changes")
    .option("-t, --title <title>", "rename only; cannot be combined with a path")
    .option("--expected-version <id>", "required with a path; reject concurrent changes; get this ID from info or export")
    .action(async (slug: string, target: string | undefined, opts: { dataContract?: string; dataCollections?: string; dataChanges?: string; operationKey?: string; official?: boolean; title?: string; expectedVersion?: string }) => {
      if (!target) {
        if (!opts.title?.trim() || opts.expectedVersion || opts.official || opts.dataContract || opts.dataChanges || opts.dataCollections) throw new CliError("Without a path, supply --title and omit --expected-version and --official", 2);
        const r = await client().rename(slug, opts.title);
        emit(r, () => io.out(r.moderation ? `Rename saved for review: ${r.moderation.requestId}` : `Renamed ${slug} to ${r.title}`)); return;
      }
      if (opts.title !== undefined) throw new CliError("Use update with either a path or --title, not both", 2);
      if (!opts.expectedVersion) throw new CliError("Content updates require --expected-version from the version you read; use info or export first", 2);
      const c = client();
      const r = await updateFromPath(c, slug, target, { ...await publicationData(opts), operationKey: opts.operationKey, official: opts.official, expectedVersion: opts.expectedVersion, onProgress: json() ? undefined : (l) => io.err(l) });
      emit({ moderation:r.moderation, slug: r.slug, kind: r.kind, versionId: r.versionId, officialVersionId: r.officialVersionId, officialRevision: r.officialRevision, siteUrl: c.absolute(r.url) }, () => io.out(`${r.moderation ? "Saved for review" : "Updated"} ${r.slug}: new version ${r.versionId}`));
    });

  const official = program.command("official").description("Manage the single official designation without changing latest contents");
  official.command("set").argument("<slug>").argument("<versionId>").action(async (slug: string, versionId: string) => {
    const c = client(); const before = await c.getOfficial(slug);
    const result = await c.setOfficial(slug, versionId, before.officialRevision);
    emit(result, () => io.out(result.moderation ? `Official designation saved for review: ${result.moderation.requestId}` : `Official version: ${result.officialVersionId}; previous designation: ${result.previousOfficialVersionId ?? "none"}. Latest unchanged.`));
  });
  official.command("clear").argument("<slug>").action(async (slug: string) => {
    const c = client(); const before = await c.getOfficial(slug);
    const result = await c.setOfficial(slug, null, before.officialRevision);
    emit(result, () => io.out("Official designation removed. Version contents unchanged."));
  });

  program.command("edit")
    .option("--data-collections <file>", "JSON collection definitions; omit to inherit, empty object disables without deleting records")
    .option("--data-contract <file>", "JSON file mapping dataset names to schemas; omission preserves the current contract")
    .option("--data-changes <file>", "JSON array of name, expectedRevision, value changes committed with the code")
    .description("Replace one remote text file, preserving other files; read it first and supply its version")
    .argument("<slug>").argument("<path>", "local UTF-8 file, or - for stdin")
    .requiredOption("--file <relpath>", "remote relative filename from info, such as index.html")
    .requiredOption("--expected-version <id>", "version read before editing; conflicts exit 4")
    .action(async (slug: string, target: string, opts: { file: string; expectedVersion: string; dataContract?: string; dataCollections?: string; dataChanges?: string }) => {
      const content = target === "-" ? await io.stdin() : await readFile(target, "utf8");
      const c = client(); const site = await c.getSite(slug);
      if (site.kind === "single" && !site.files.includes(opts.file)) throw new CliError("--file must name the single page shown by info", 2);
      const result = await c.edit(slug, { ...(site.kind === "single" ? {} : { path: opts.file }), content, ...await publicationData(opts) }, opts.expectedVersion);
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
    emit({ scope: "mine", ...r }, () => {
      const row = (s: { slug: string; title: string; kind: string; visibility?: string }) => `  ${s.slug.padEnd(14)} ${s.kind.padEnd(9)} ${(s.visibility ?? "").padEnd(9)} ${s.title}`;
      io.out(`owned (${r.owned.length}):`); r.owned.forEach((s) => io.out(row(s)));
      if (r.collaborating.length) { io.out(`collaborating (${r.collaborating.length}):`); r.collaborating.forEach((s) => io.out(row(s))); }
    });
  };
  program.command("list", { hidden: true }).description("Compatibility alias: use find without keywords").action(listMine);

  program.command("info").description("Inspect a remote artifact: kind, current version, files and history; optionally sharing records").argument("<slug>").option("--shares", "include share summaries (requires owner permission)").action(async (slug: string, opts: { shares?: boolean }) => {
    const c = client(Boolean(opts.shares));
    const [info, versions, official] = await Promise.all([c.getSite(slug), c.listVersions(slug), c.getOfficial(slug)]);
    const shares = opts.shares ? await c.listShares(slug) : undefined;
    emit({ ...info, ...shares, ...official, content: undefined, currentVersionId: versions.currentVersionId, versions: versions.versions }, () => {
      io.out(`${info.title} — ${info.kind} — ${c.absolute(info.url)}`);
      io.out(`current version: ${versions.currentVersionId}  (${versions.versions.length} in history)`);
      io.out(`official version: ${official.officialVersionId ?? "none"}`);
      if (shares) io.out(`share records: ${shares.shares.length} (secret links are not returned)`);
      io.out(`files (${info.files.length}): ${info.files.slice(0, 20).join(", ")}${info.files.length > 20 ? ", …" : ""}`);
    });
  });

  const search = async (words: string[], opts: { limit?: number }) => {
    const c = client(false);
    const r = await c.search(words.join(" "), opts.limit);
    emit({ scope: "discoverable", query: r.query, results: r.results.map((s) => ({ ...s, url: c.absolute(s.url) })) }, () => {
      io.out("Discoverable results (owned, collaborative and other public works; visibility is separate):");
      if (!r.results.length) { io.out("no matches"); return; }
      for (const s of r.results) {
        io.out(`${s.slug}  [${s.relationship ?? "discoverable"}] ${s.kind.padEnd(8)} ${(s.visibility ?? "").padEnd(8)} ${s.title}`);
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
    .option("--public", "explicit public catalog, not my sites; omit keywords")
    .addHelpText("after", "Personal lists require a personal account. Empty lists do not mean signed out. Failures never fall back silently: use whoami to diagnose, or find --public to explicitly view public works. Keyword results retain relationship labels independently of visibility.")
    .action(async (words: string[], opts: { limit?: number; public?: boolean }) => {
      if (opts.public) {
        if (words.length) throw new CliError("--public lists the public catalog without keywords; omit --public for labeled keyword search", 2);
        const c = client(false), result = await c.publicSites();
        emit({ scope: "public", ...result }, () => {
          io.out("Public catalog — these are not necessarily your sites:");
          for (const site of result.sites) io.out(`${site.slug}  [public] ${site.title}`);
          if (!result.sites.length) io.out("no public sites");
        });
        return;
      }
      if (words.length) return search(words, opts);
      return listMine();
    });
  program.command("search", { hidden: true }).description("Compatibility alias: use find <keywords>")
    .argument("<query...>").option("-n, --limit <n>", "maximum results (1-50)", resultLimit).action(search);

  const folders = program.command("folders").description("Organize the connected personal account's library; operator credentials have no personal folders");
  folders.command("list").description("List my flat folder labels with stable IDs; save an ID for subsequent moves")
    .action(async () => {
      const { folders } = await client().listFolders();
      emit({ scope: "mine", folders }, () => {
        io.out(`My folders (${folders.length}):`);
        for (const folder of folders) io.out(`${folder.id}  ${folder.name}`);
      });
    });
  program.command("move").description("Move an owned or collaborative artifact into my folder; changes no content or sharing")
    .argument("<slug>", "existing artifact slug, including a just-published artifact")
    .option("--folder <id>", "folder ID from folders list")
    .option("--unfiled", "remove the current folder assignment")
    .addHelpText("after", "Choose exactly one of --folder or --unfiled. Repeating a move is safe. Missing/inaccessible targets fail explicitly. If publication succeeded but moving failed, retry only the move.")
    .action(async (slug: string, opts: { folder?: string; unfiled?: boolean }) => {
      if ((opts.folder !== undefined) === Boolean(opts.unfiled) || (opts.folder !== undefined && !opts.folder.trim())) throw new CliError("Choose exactly one nonempty --folder <id> or --unfiled", 2);
      const result = await client().moveToFolder(slug, opts.unfiled ? null : opts.folder!);
      emit(result, () => io.out(`${result.slug} moved to ${result.folderId ?? "Unfiled"}. Content and sharing are unchanged.`));
    });

  program.command("read").description("Read a remote report/document for summarizing or reuse; --file reads one original text file")
    .argument("<slug>").option("-f, --file <relpath>", "one file of the tree, verbatim (text types only)")
    .option("--version-id <id>", "read this exact authorized version")
    .option("--max-chars <n>", "cut the text after this many characters (default 20000)", (v) => Number(v))
    .action(async (slug: string, opts: { file?: string; maxChars?: number; versionId?: string }) => {
      const c = client(false);
      const r = await c.readText(slug, { file: opts.file, maxChars: opts.maxChars, versionId:opts.versionId });
      emit({ ...r, url: c.absolute(r.url) }, () => {
        io.out(r.text);
        if (r.truncated) io.err(`(truncated: ${r.chars} characters in total; raise --max-chars to see more)`);
      });
    });

  const comments = program.command("comments").description("Read feedback and exact context before updating the same artifact; never marks comments read");
  const pageLimit = (value: string) => { const n = Number(value); if (!Number.isInteger(n) || n < 1 || n > 100) throw new InvalidArgumentError("limit must be 1-100"); return n; };
  comments.command("list").argument("<slug>").description("Current-version feedback, inheritance provenance and synchronization state; aggregate requires management access")
    .option("--version-id <id>", "exact comment version").option("--share-id <id>", "filter one discussion in aggregate mode")
    .option("--aggregate", "include authorized discussions through the main entrance").option("--all-versions", "include all versions; requires --aggregate")
    .option("--status <status>", "open | resolved", v => { if (!["open", "resolved"].includes(v)) throw new InvalidArgumentError("status must be open or resolved"); return v; })
    .option("--cursor <cursor>", "nextCursor from previous page; keep the same scope and version")
    .option("--limit <n>", "page size (1-100)", pageLimit)
    .action(async (slug: string, opts: { versionId?: string; shareId?: string; aggregate?: boolean; allVersions?: boolean; status?: string; cursor?: string; limit?: number }) => {
      if (opts.allVersions && (!opts.aggregate || opts.versionId)) throw new CliError("--all-versions requires --aggregate and omits --version-id", 2);
      io.out(JSON.stringify(await client(false).listComments(slug, opts), null, json() ? undefined : 2));
    });
  comments.command("read").argument("<slug>").argument("<thread-id>").description("Read discussion; follow messages.nextCursor using --cursor until null")
    .option("--cursor <cursor>", "read another messages page").option("--limit <n>", "continuation page size", pageLimit)
    .action(async (slug: string, threadId: string, opts: { cursor?: string; limit?: number }) => {
      if (opts.limit && !opts.cursor) throw new CliError("--limit requires --cursor", 2);
      io.out(JSON.stringify({ ...await client(false).readComment(slug, threadId, opts.cursor, opts.limit), dataTrust: "untrusted" }, null, json() ? undefined : 2));
    });
  comments.command("context").argument("<slug>").argument("<thread-id>").description("Version-local anchor/context, inheritance provenance, sync state and independent source/edit capabilities")
    .action(async (slug: string, threadId: string) => io.out(JSON.stringify(await client(false).commentContext(slug, threadId), null, json() ? undefined : 2)));

  program.command("revoke-share").description("Revoke an independent link; main-link access is unchanged").argument("<slug>").argument("<share-id>")
    .action(async (slug: string, shareId: string) => { const result = await client().revokeShare(slug, shareId); emit(result, () => io.out("Independent share revoked.")); });

  program.command("share")
    .description("Advanced: create an independent link and isolated discussion; ordinary sharing uses visibility")
    .argument("<slug>")
    .option("-p, --policy <policy>", "public | login | email | passcode", (v) => { const p = parsePolicy(v); if (!p) throw new InvalidArgumentError("policy is required"); return p; }, "public")
    .option("--mode <mode>", "view | comment | edit", (v) => { if (!["view","comment","edit"].includes(v)) throw new InvalidArgumentError("invalid share mode"); return v; }, "view")
    .option("-l, --label <label>", "a label to tell links apart")
    .option("--expires <days>", "7, 30 or 90", (v) => { const n = Number(v); if (![7, 30, 90].includes(n)) throw new InvalidArgumentError("expires must be 7, 30 or 90"); return n; })
    .option("--passcode <code>", "choose the passcode (policy passcode); omitted = generated")
    .action(async (slug: string, opts: { mode?: "view" | "comment" | "edit"; policy: SharePolicy; label?: string; expires?: number; passcode?: string }) => {
      const r = await client().createShare(slug, { mode: opts.mode, policy: opts.policy, label: opts.label, expiresInDays: opts.expires, passcode: opts.passcode });
      emit(r, () => io.out(r.moderation ? `Review pending: ${r.moderation.requestId}; no reader link is active yet${r.passcode ? `; passcode ${r.passcode} (save now; shown only once)` : ""}` : `${r.url}${r.passcode ? `  (passcode ${r.passcode})` : ""}`));
    });

  registerRecordCommands(program, () => client(), io);
  const dataCommands = program.command("data").description("Read or replace shared artifact JSON data; browser pages refresh manually");
  dataCommands.command("list").argument("<slug>").option("--version-id <id>", "historical snapshot (requires history access)")
    .action(async (slug: string, opts: { versionId?: string }) => io.out(JSON.stringify(await client(false).dataList(slug, opts.versionId), null, 2)));
  dataCommands.command("get").argument("<slug>").argument("<name>").option("--version-id <id>", "historical snapshot")
    .action(async (slug: string, name: string, opts: { versionId?: string }) => io.out(JSON.stringify(await client(false).dataGet(slug, name, opts.versionId), null, 2)));
  dataCommands.command("set").argument("<slug>").argument("<name>").argument("<file>", "JSON value file, or - for stdin")
    .requiredOption("--expected-version <id>", "version returned by data get")
    .requiredOption("--expected-revision <number>", "dataset revision returned by data get", (raw) => { const n = Number(raw); if (!Number.isSafeInteger(n) || n < 0) throw new InvalidArgumentError("revision must be a nonnegative integer"); return n; })
    .action(async (slug: string, name: string, file: string, opts: { expectedVersion: string; expectedRevision: number }) => {
      let value: unknown;
      try { value = JSON.parse(file === "-" ? await io.stdin() : await readFile(file, "utf8")); } catch { throw new CliError("Provide a readable JSON value", 2); }
      const result = await client().dataSet(slug, name, opts.expectedVersion, opts.expectedRevision, value);
      emit(result, () => io.out(`Saved ${name}. Refresh the page to load the data.`));
    });
  program.command("download").description("Download original files or an existing archive; live data is not assembled")
    .argument("<slug>").option("--version-id <id>", "authorized historical version").option("--file <path>", "individual file from the version manifest").option("-o, --out <file>", "output filename")
    .action(async (slug: string, opts: { out?: string; versionId?: string; file?: string }) => {
      const { file, versionId, bytes } = await cancellableDownload(signal => client().downloadToFile(slug, { ...opts, signal }));
      emit({ file, versionId, bytes }, () => io.out(`${file} (${mb(bytes)})`));
    });

  program.command("export").description("Download original files or a stored archive; prints the version id for --expected-version")
    .argument("<slug>").option("--version-id <id>", "export this exact authorized version").option("-o, --out <file>", "output file (default original filename)")
    .action(async (slug: string, opts: { out?: string; versionId?: string }) => {
      const { file, versionId, bytes } = await cancellableDownload(signal => client().downloadToFile(slug, { ...opts, signal }));
      emit({ slug, versionId, file, bytes }, () => io.out(`${file} (${mb(bytes)}), version ${versionId}`));
    });

  program.command("rollback").description("Restore historical code and schema while preserving current data").argument("<slug>").argument("<versionId>")
    .option("--expected-version <id>", "current version read before rollback; required for data-enabled artifacts")
    .option("--data-changes <file>", "JSON transformations of current data if required by the target schema")
    .action(async (slug: string, versionId: string, opts: { expectedVersion?: string; dataChanges?: string }) => { const r = await client().rollback(slug, versionId, opts.expectedVersion, (await publicationData(opts)).dataChanges); emit(r, () => io.out(`Rolled back ${slug}: new version ${r.versionId}`)); });

  program.command("rename", { hidden: true }).description("Change a site's title").argument("<slug>").argument("<title>")
    .action(async (slug: string, title: string) => { const r = await client().rename(slug, title); emit(r, () => io.out(r.moderation ? `Rename saved for review: ${r.moderation.requestId}` : `Renamed ${slug} to ${r.title}`)); });

  program.command("delete").description("Delete a site you own").argument("<slug>")
    .action(async (slug: string) => { const r = await client().delete(slug); emit(r, () => io.out(`Deleted ${slug}`)); });

  program.command("mcp")
    .description("Run a local MCP server over stdio that forwards to this server's /mcp with this CLI's credential")
    .action(async () => {
      // From here on stdout carries JSON-RPC only: anything else that would print goes to stderr.
      const { format } = await import("node:util");
      console.log = console.info = console.debug = (...args: unknown[]) => { process.stderr.write(format(...args) + "\n"); };
      // Signed out is a valid state here (the bundled tool list is still served), so neither a
      // missing nor an invalid address may stop the server from starting.
      let baseUrl: string | null = null, baseError: string | undefined;
      try { baseUrl = resolveBaseUrl(program.opts().base); } catch (error) { baseError = (error as Error).message; }
      const token = baseUrl ? readToken(baseUrl) : null;
      const { serveMcp } = await import("./mcp.js");
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const closed = new Promise<void>((resolve) => { process.stdin.once("end", resolve); process.stdin.once("close", resolve); });
      await serveMcp({ baseUrl, token, baseError, version: packageVersion(), log: io.err }, new StdioServerTransport(), closed);
    });

  const skill = program.command("skill").description("Install/update the complete agent skill or read deployment references")
    .action(async () => io.out(await client(false).skill()));
  for (const action of ["install", "update", "check"] as const) {
    skill.command(action).description(action + " the complete skill from the official release source")
      .option("--agent <name>", "override the detected agent: codex, claude-code, cursor or opencode")
      .option("--dir <directory>", "explicit skill directory for another host")
      .option("--bundled", "use the exact skill bundled in this npm package, without network access")
      .action(async (opts: { agent?: string; dir?: string; bundled?: boolean }) => {
        const result = await installSkill({ action, directory: skillDirectory(opts.agent, opts.dir), bundled: opts.bundled });
        emit(result, () => {
          io.out(result.status + ": " + result.directory + " (" + result.version + ")");
          if (result.backupDirectory) io.out("Previous skill retained at " + result.backupDirectory);
        });
      });
  }
  skill.command("docs").description("Check deployment versions and read only requested topics")
    .requiredOption("--topic <names>", "comma-separated reference topics, e.g. publish,runtime")
    .option("--dir <directory>", "installed skill directory to reuse matching local references")
    .action(async (opts: { topic: string; dir?: string }) => {
      const result = await readSkillDocs({ base: base(), topics: opts.topic.split(",").map(t => t.trim()), installedDirectory: opts.dir });
      emit(result, () => { io.out("Documentation version: " + (result.version ?? "legacy/unversioned")); for (const doc of result.documents) io.out(doc.text); });
    });

  return program;
}

/** Let interrupted disk transfers clean up before the process exits. */
async function cancellableDownload<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let exitCode = 130;
  const interrupt = () => controller.abort();
  const terminate = () => { exitCode = 143; controller.abort(); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", terminate);
  try { return await work(controller.signal); }
  catch (error) { if (controller.signal.aborted) throw new CliError("Download cancelled", exitCode); throw error; }
  finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); }
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
