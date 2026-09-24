import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import ViewerBrand from "@/components/viewer-brand";

it("uses the actual product asset and one decorative return icon", () => {
  const html = renderToStaticMarkup(createElement(ViewerBrand));
  expect(html).toContain('src="/brand/logo.png"');
  expect(html).toContain('alt="artifact-site"');
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain('class="viewer-brand-logo"');
});

it("shares the brand across owner, shared, editor, version and notification viewers", () => {
  for (const file of ["components/site-viewer.tsx", "app/v/[token]/page.tsx", "components/editor.tsx", "components/version-picker.tsx", "app/notifications/[id]/page.tsx"]) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    expect(source, file).toContain("<ViewerBrand />");
    expect(source, file).not.toContain("<b>artifact-site</b>");
  }
});
