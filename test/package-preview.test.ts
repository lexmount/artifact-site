import { expect, it } from "vitest";
import { packageCss, packageHtml } from "@/lib/package-preview";
const root = "/api/preview/site~version/";
it("resolves responsive images while preserving data URL commas and descriptors", () => {
  const html = packageHtml('<picture><source srcset="/small.png 1x, ../large.png 2x"><img srcset="data:image/png;base64,AAAA 1x, /large.png 2x"></picture>', "pages/index.html", root).html;
  expect(html).toContain(`srcset="${root}small.png 1x, ${root}large.png 2x"`);
  expect(html).toContain(`srcset="data:image/png;base64,AAAA 1x, ${root}large.png 2x"`);
});
it("resolves quoted CSS URLs containing spaces", () => {
  expect(packageCss('body{background:url("/images/my chart.png")}', root + "css/", root)).toContain(`url("${root}images/my%20chart.png")`);
});
