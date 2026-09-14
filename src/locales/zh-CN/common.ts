import type { Messages } from "@/lib/i18n";

/** Shared chrome: app title, navigation, generic buttons. Feature areas keep their own files. */
export const common: Messages = {
  "artifact-site — turn your work into a link to share and collaborate": "artifact-site — 把作品，变成可分享、可协作的链接",
  "Upload it and it is online. Pages, reports, dashboards — all become links you can share and edit in place.":
    "上传即上线。页面、报告、看板，都能变成可分享、可在线修改的链接。",
  // Counts (countText): Chinese has no plural, so both keys share one value.
  "{n} version": "{n} 个版本",
  "{n} versions": "{n} 个版本",
  "{n} file": "{n} 个文件",
  "{n} files": "{n} 个文件",
  "{n} site": "{n} 个站点",
  "{n} sites": "{n} 个站点",
  "{n} token": "{n} 个令牌",
  "{n} tokens": "{n} 个令牌",
  // Language switch
  "Choose a language": "选择语言",
};
