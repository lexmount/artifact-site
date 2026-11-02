import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import RecentList from "@/components/recent-list";
import { LocaleProvider } from "@/components/locale-provider";
import type { RecentShelf } from "@/components/recent-sites";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

it("renders named, anonymous and legacy authors alongside existing history fields", () => {
  const shelf: RecentShelf = {
    ready: true, remove: vi.fn(), clear: vi.fn(),
    items: ["Ada Lovelace — Product Research and Design", null, undefined].map((authorName, i) => ({
      summary: { slug: `work-${i}`, title: ["季度产品调研报告", "交互演示", "设计方案归档"][i], kind: "single", entry: "index.html", versionCount: 2, createdAt: 0, updatedAt: 0, authorName },
      visitedAt: Date.now(), href: `/s/work-${i}`, preview: `/api/preview/work-${i}?thumb=1`,
    })),
  };
  const html = renderToStaticMarkup(LocaleProvider({ locale: "zh-CN", children: createElement(RecentList, { shelf }) }));
  expect(html).toContain("Ada Lovelace");
  expect(html).toContain("匿名作者");
  expect(html).toContain("未知作者");
  expect(html).toContain('data-label="作者"');
  expect(html).toContain('class="row-date"');
  expect(html).toContain('class="row-versions"');
  expect(html).toContain('class="row-menu-wrap"');
  if (process.env.HISTORY_PREVIEW_DIR) {
    mkdirSync(process.env.HISTORY_PREVIEW_DIR, { recursive: true });
    writeFileSync(`${process.env.HISTORY_PREVIEW_DIR}/index.html`, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${readFileSync("src/app/globals.css", "utf8")}</style><body><main style="max-width:1120px;margin:auto;padding:24px"><h1>最近浏览</h1>${html}</main></body></html>`);
  }
});
