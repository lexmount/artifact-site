import { expect, it, vi } from "vitest";
import { run } from "../src/cli.js";

// These options used to either call nonexistent routes or silently lose requested behavior.
it.each([
  ["data", "list", "site"], ["collections", "list", "site"],
  ["records", "list", "site", "tasks"], ["snapshot", "site", "--out", "page.zip"],
  ...["--data-contract", "--data-changes", "--data-collections"].flatMap(flag => [
    ["publish", "-", flag, "input.json"],
    ["update", "site", "index.html", "--expected-version", "v1", flag, "input.json"],
    ["edit", "site", "-", "--file", "index.html", "--expected-version", "v1", flag, "input.json"],
  ]),
  ["rollback", "site", "v1", "--expected-version", "v2"],
  ["rollback", "site", "v1", "--data-changes", "input.json"],
  ["download", "site", "--file", "index.html"],
])("rejects unsupported open-source arguments before connecting: %j", async (...args) => {
  const io = { out: vi.fn(), err: vi.fn(), stdin: vi.fn(async () => "<h1>Test</h1>") };
  const connect = vi.fn(() => { throw new Error("Must not connect"); });
  expect(await run(["--base", "https://example.test", ...args], io, connect)).toBe(2);
  expect(io.err.mock.calls.flat().join("\n")).toMatch(/unknown (command|option)/);
  expect(connect).not.toHaveBeenCalled();
  expect(io.stdin).not.toHaveBeenCalled();
});
