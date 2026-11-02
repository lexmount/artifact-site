import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? sources(file) : /\.tsx?$/.test(file) ? [file] : [];
  });
}

it("library and application modules never depend on Next route modules", () => {
  const forbidden: string[] = [];
  for (const file of sources("src/lib")) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
        : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require") ? node.arguments[0] : undefined;
      if (specifier && ts.isStringLiteral(specifier)) {
        const target = specifier.text.startsWith("@/") ? resolve("src", specifier.text.slice(2))
          : specifier.text.startsWith(".") ? resolve(file, "..", specifier.text) : "";
        if (target && relative(resolve("src/app"), target).split(/[\\/]/)[0] !== "..") forbidden.push(`${file}: ${specifier.text}`);
        const metadataAdapter = file === "src/lib/db-postgres.ts" || file === "src/lib/db-sqlite.ts";
        const typeOnly = ts.isImportDeclaration(node) && node.importClause?.isTypeOnly;
        if ((file === "src/lib/metadata-model.ts" || metadataAdapter && !typeOnly) && target === resolve("src/lib/db")) forbidden.push(`${file}: ${specifier.text}`);
        if (file === "src/lib/db.ts" && /\/(?:authorized-commit|publication-(?:service|fixtures|commit)|site-events)$/.test(specifier.text)) forbidden.push(`${file}: ${specifier.text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(forbidden).toEqual([]);
});
