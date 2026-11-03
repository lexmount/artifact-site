import type { Messages } from "@/lib/i18n";

/** Shared chrome: app title, navigation, generic buttons. Feature areas keep their own files. */
export const common: Messages = {
  "My artifacts": "我的作品",
  "artifact-site — manage your agent’s work and collaborate": "artifact-site — 管理 Agent 的作品，让它成为协作的桥梁",
  "Manage your agent’s pages, reports and documents. Share a link, discuss with your collaborators, and let an agent keep improving the work.": "管理 Agent 生成的网页、报告和文档。用一个链接分享，和小伙伴一起讨论，让 Agent 接着完善。",

  // Counts (countText): Chinese has no plural, so both keys share one value.
  "{n} version": "{n} 个版本",
  "{n} versions": "{n} 个版本",
  "{n} file": "{n} 个文件",
  "{n} files": "{n} 个文件",
  "{n} sites": "{n} 个站点",
  "{n} token": "{n} 个令牌",
  "{n} tokens": "{n} 个令牌",
  // Language switch
  "Choose a language": "选择语言",
};
