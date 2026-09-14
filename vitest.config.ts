import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The suite runs STRICTLY SERIALLY, and the three settings below are load-bearing, not tuning:
//
//   - Every test file shares one on-disk state directory (`.data/test`, wiped by test/setup.ts)
//     holding the sqlite database and the local file store. Two files running at once would
//     see each other's sites, and one file's wipe would pull the disk out from under another.
//   - lib/config reads `process.env` lazily on every access, and many tests set variables
//     (limits, policies, drivers) for the duration of a case. Environment is per process, so
//     concurrent cases in one worker would leak settings into each other.
//
// `fileParallelism: false` + `maxWorkers: 1` keep files sequential in one worker;
// `sequence.concurrent: false` keeps cases inside a file sequential. Relaxing any of them needs a
// per-file data dir and per-case env isolation first.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { concurrent: false },
    testTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
