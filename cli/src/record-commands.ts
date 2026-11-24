import { readFile } from "node:fs/promises";
import { Command, InvalidArgumentError } from "commander";
import { ArtifactSiteClient } from "./client.js";
import { CliError, type Io } from "./cli.js";
const positive = (raw: string) => { const n = Number(raw); if (!Number.isSafeInteger(n) || n < 1) throw new InvalidArgumentError("Expected a positive integer"); return n; };
type WriteOptions = { expectedVersion: string; expectedRevision: number; operationKey: string; unset?: string[] };
export function registerRecordCommands(program: Command, client: () => ArtifactSiteClient, io: Io) {
  const output = (value: unknown) => io.out(JSON.stringify(value, null, 2));
  const jsonFile = async (file: string) => { try { return JSON.parse(file === "-" ? await io.stdin() : await readFile(file, "utf8")); } catch { throw new CliError("Provide a readable JSON file or - for stdin", 2); } };
  const collections = program.command("collections").description("Manage record schemas, access and usage (owner/platform administrator)");
  collections.command("list").argument("<slug>").action(async slug => output(await client().collections(slug)));
  collections.command("access").argument("<slug>").argument("<name>").argument("<file>", "JSON with access and optional publicMutation/rate")
    .requiredOption("--expected-version <id>", "current page version")
    .requiredOption("--expected-revision <number>", "policyRevision from collections list", positive)
    .action(async (slug: string, name: string, file: string, opts: WriteOptions) => output(await client().collectionAccess(slug, name, opts.expectedVersion, { ...await jsonFile(file), expectedRevision: opts.expectedRevision })));
  collections.command("delete").argument("<slug>").argument("<name>").description("Permanently remove a disabled collection and all retained records")
    .requiredOption("--expected-version <id>", "current page version").requiredOption("--expected-revision <number>", "policy revision", positive).requiredOption("--delete-records", "explicitly confirm permanent deletion")
    .action(async (slug: string, name: string, opts: WriteOptions) => output(await client().collectionDelete(slug, name, opts.expectedVersion, opts.expectedRevision)));
  const records = program.command("records").description("Read or change individual records without publishing HTML");
  const searchOptions = (cmd: Command) => cmd.option("--query <text>", "search values across the whole collection").option("--filter <json>", 'exact typed match, e.g. {"field":"done","value":false}');
  searchOptions(records.command("list").argument("<slug>").argument("<name>").option("--cursor <cursor>", "nextCursor from the previous page").option("--limit <number>", "page size, at most 100", positive, 50))
    .action(async (slug: string, name: string, opts: { cursor?: string; limit: number; query?: string; filter?: string }) => output(await client().records(slug, name, opts.cursor, opts.limit, { q: opts.query, filter: opts.filter })));
  searchOptions(records.command("export").argument("<slug>").argument("<name>").requiredOption("-o, --out <file>", "output CSV file; all matches, at most 5000 rows / 8 MiB"))
    .action(async (slug: string, name: string, opts: { out: string; query?: string; filter?: string }) => output(await client().recordsExport(slug, name, opts.out, { q: opts.query, filter: opts.filter })));
  records.command("import").argument("<slug>").argument("<name>").argument("<file>", "JSON array of at most 200 records, or - for stdin; append only")
    .requiredOption("--expected-version <id>", "current page version").requiredOption("--operation-key <key>", "persist before committing; reuse identical input on retry").option("--validate-only", "check every row without saving")
    .action(async (slug: string, name: string, file: string, opts: WriteOptions & { validateOnly?: boolean }) => output(await client().recordImport(slug, name, opts.expectedVersion, { rows: await jsonFile(file), operationKey: opts.operationKey, validateOnly: Boolean(opts.validateOnly) })));
  records.command("get").argument("<slug>").argument("<name>").argument("<id>").action(async (slug: string, name: string, id: string) => output(await client().recordGet(slug, name, id)));
  const create = records.command("create").argument("<slug>").argument("<name>").argument("<file>", "JSON object, or - for stdin");
  const update = records.command("update").argument("<slug>").argument("<name>").argument("<id>").argument("<file>", "JSON fields to merge, or - for stdin").option("--unset <fields...>", "optional fields to remove");
  const remove = records.command("delete").argument("<slug>").argument("<name>").argument("<id>");
  for (const cmd of [create, update, remove]) {
    cmd.requiredOption("--expected-version <id>", "current page version").requiredOption("--operation-key <key>", "save a unique key before calling; reuse identical input after uncertain responses for 24 hours");
    if (cmd !== create) cmd.requiredOption("--expected-revision <number>", "record revision from records get/list", positive);
  }
  create.action(async (slug: string, name: string, file: string, opts: WriteOptions) => output(await client().recordWrite("POST", slug, name, opts.expectedVersion, { value: await jsonFile(file), operationKey: opts.operationKey })));
  update.action(async (slug: string, name: string, id: string, file: string, opts: WriteOptions) => output(await client().recordWrite("PATCH", slug, name, opts.expectedVersion, { value: await jsonFile(file), unset: opts.unset ?? [], expectedRevision: opts.expectedRevision, operationKey: opts.operationKey }, id)));
  remove.action(async (slug: string, name: string, id: string, opts: WriteOptions) => output(await client().recordWrite("DELETE", slug, name, opts.expectedVersion, { expectedRevision: opts.expectedRevision, operationKey: opts.operationKey }, id)));
  program.command("snapshot").description("Download the current page with saved JSON and explicitly selected records; offline writes are disabled")
    .argument("<slug>").option("--collections <names...>", "explicitly include these collections; requires data management", []).requiredOption("-o, --out <file>", "output ZIP file")
    .action(async (slug: string, opts: { collections: string[]; out: string }) => output(await client().snapshotToFile(slug, opts.collections, opts.out)));
}
