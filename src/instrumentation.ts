// Runs once when the Next server process starts (not during `next build`, not under vitest).
// Prints which backends are in effect and refuses to start on a combination that cannot work —
// the alternative is a server that reports healthy and fails on the first upload.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Everything Node-specific lives behind the dynamic import: this file is also bundled for the
  // edge runtime, whose analyser flags a literal `process.exit` here even though the guard above
  // never lets it run there.
  const { describeRuntime, exitOnFatalConfig } = await import("@/lib/runtime");
  // Console-set policy overlays the environment; load it before the summary and the first request.
  const { refreshSettings } = await import("@/lib/settings");
  await refreshSettings().catch((e) => console.warn("[runtime] could not load console settings yet (they apply once the database answers):", e));
  const report = describeRuntime();
  for (const line of report.lines) console.log(`[runtime] ${line}`);
  for (const warning of report.warnings) console.warn(`[runtime] WARN: ${warning}`);
  if (report.errors.length === 0) return;
  for (const error of report.errors) console.error(`[runtime] FATAL: ${error}`);
  console.error("[runtime] This configuration cannot work; refusing to start. Fix .env and restart (locally, run `make doctor` first).");
  exitOnFatalConfig();
}
