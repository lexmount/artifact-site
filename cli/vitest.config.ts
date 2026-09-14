import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    // Tests write the CLI's config dir; each file points ARTIFACT_SITE_CONFIG_DIR at its own temp dir.
    fileParallelism: false,
  },
});
