import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import tseslint from "typescript-eslint";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", ".data/**", "coverage/**", "playwright-report/**", "public/vendor/**", "cli/**"]),
  // Type-aware rules, scoped to the routes + authz. no-floating-promises is a security control
  // here, not style: authorization is `await requireCapability(...)`, and a dropped await leaves a
  // pending promise nobody checks — the route would authorize everyone while CI stayed green.
  {
    files: ["src/app/api/**/*.ts", "src/lib/authz.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
]);
