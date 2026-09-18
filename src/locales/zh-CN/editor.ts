import type { Messages } from "@/lib/i18n";

/** Viewer chrome (/s/[slug]), the source + visual editors, and the assistant mount. */
export const editor: Messages = {
  "This report has changed. Your edits are still here; copy them before refreshing to review the latest version.": "报告已有新版本。你的修改仍保留，请先复制修改内容，再刷新查看最新版。",
  "All files come from {label}; saving creates a new latest version": "所有文件均来自 {label}，保存后将创建新的最新版",
  "All files come from earlier version {label}. Saving creates a new latest version; {label} and the official version remain unchanged.": "所有文件均来自历史版本 {label}。保存后将创建新的最新版，{label} 和正式版均保持不变。",

  // ── site-viewer ──────────────────────────────────────────────────────────────
  "Published · Only you can open it for now. Create a share link under Sharing settings before sending it to others":
    "已发布 · 目前只有你能打开，到「分享设置」里建一条分享链接再发给别人",
  "Published · Copy the link under Sharing settings": "已发布 · 到「分享设置」里复制链接",
  "Rename failed": "重命名失败",
  "Renamed": "已重命名",
  "Uploading the new version failed": "上传新版本失败",
  "New version published · The share link is unchanged": "已发布新版本 · 分享链接不变",
  "Save as new site failed": "另存失败",
  "Saved as a new site": "已另存为新站点",
  "Rolled back · A new version was created": "已回滚 · 已生成新版本",
  "Site action bar": "站点操作条",
  "Back to sites": "返回站点列表",
  "Site title": "站点标题",
  "Click to rename": "点击重命名",
  "Preview device": "预览设备",
  "Desktop": "桌面",
  "Tablet": "平板",
  "Mobile": "手机",
  "Re-upload the whole document: a new version is published at the same link, and earlier versions can be rolled back":
    "重传整份文档：同一链接发布新版本，历史版本可回滚",
  "Upload new version": "上传新版本",
  "Copy into a separate new site": "复制成一个独立的新站点",
  "Save as new site": "另存为新站点",
  "Sharing settings": "分享设置",
  "Sign in required": "需登录",
  "Edit": "编辑",
  "Private site: others cannot open this address directly. Get a share link from Sharing settings":
    "私有站点，直接发这个地址别人打不开；到「分享设置」取一条分享链接",
  "Open the artifact itself in a new window (without this action bar). This is not a share link — use Sharing settings to show it to others.":
    "在新窗口打开产物本身（不含这条操作条）。这不是分享链接——给别人看请用「分享设置」。",
  "Open the artifact itself in a new window, without this action bar.": "在新窗口打开产物本身，不含这条操作条。",
  "Open in new window": "新窗口打开",
  "Action bar: opens automatically. Click to switch to manual": "操作条：自动展开。点击改为手动",
  "Action bar: opens manually. Click to switch to automatic": "操作条：手动展开。点击改为自动",
  "Action bar: automatic. Rest the mouse on the top edge for 0.2 s to open it; it hides again when the mouse leaves. Click to switch to manual (opens/closes only when you click the handle).":
    "操作条：自动。鼠标在页面上沿停留 0.2 秒就展开，移开后自动收起。点击改为手动（只在点击把手时展开/收起）。",
  "Action bar: manual. Opens/closes only when you click the handle above; moving the mouse across the top edge does nothing. Click to switch to automatic (opens after the mouse rests on the top edge for 0.2 s).":
    "操作条：手动。只在点击上方把手时展开/收起，鼠标经过上沿不会弹出。点击改为自动（鼠标停在上沿 0.2 秒即展开）。",
  "Hide action bar": "隐藏操作条",
  "Show action bar": "显示操作条",

  // ── editor (source editor shell) ─────────────────────────────────────────────
  "“{entry}” has unsaved source changes, and they will not carry over to visual editing. Discard the changes to this one file and continue? (Unsaved changes in other files are kept)":
    "「{entry}」有未保存的源码修改，切到可视化编辑不会带上它们。要放弃这一个文件的修改并继续吗？（其它文件的未保存改动会保留）",
  "Visual editing has unsaved changes; switching to source will discard them. Continue?":
    "可视化编辑里有未保存的改动，切到源码会丢掉它们。继续吗？",
  "Saved · A new version was created": "已保存 · 已生成新版本",
  "Save failed ({status})": "保存失败（{status}）",
  "Save failed": "保存失败",
  "There are unsaved changes. Save as new site only includes the saved version; unsaved content will not be in the copy. Continue?":
    "有未保存的修改。另存只包含已保存的版本，未保存内容不会进入副本。继续？",
  "There are unsaved changes that will be lost if you leave. Go back anyway?": "有未保存的修改，离开会丢失。确定返回吗？",
  "Back to viewer": "返回查看",
  "You do not have edit access to this site (an editable link is required).": "你没有此站点的编辑权限（需要可编辑链接）。",
  "Viewing is open, but only the site owner or someone holding an editable link can change it.":
    "查看是公开的，但只有站点所有者或持有「可编辑链接」的人才能修改它。",
  "Copy into a new site that you own and can edit": "复制成一个你自己拥有、可编辑的新站点",
  "Save as my editable copy": "另存为我的可编辑副本",
  "Based on {label}": "基于 {label}",
  "Back to version selection: pick a different base version, or make a copy and edit that":
    "回到版本选择：换一个基准版本，或者复制成副本再改",
  "Switch version": "换版本",
  "Open the artifact itself in a new tab": "在新标签里打开产物本身",
  "Open in new tab": "新标签打开",
  "Advanced: edit the HTML source directly (for styles, scripts, and other files)":
    "高级：直接编辑 HTML 源码（改样式、脚本、其它文件时用）",
  "Edit source": "源码编辑",
  "Back to visual editing, where you double-click text to change it": "回到双击改字的可视化编辑",
  "Edit visually": "可视化编辑",
  "Save new version": "保存新版本",
  "Editing version {version}": "编辑版本 {version}",
  "Saving creates a new immutable version; earlier versions stay unchanged.": "保存会生成一个新的不可变版本；旧版本保持不变。",
  "Unsaved": "未保存",
  "Choose a file to edit": "选择要编辑的文件",
  "{path} (binary or too large, not editable)": "{path}（二进制/过大，不可编辑）",
  "This site has no text files that can be edited online. Re-upload it from the home page to update it.":
    "这个站点没有可在线编辑的文本文件。你可以在首页重新上传以更新它。",
  "Source · {path}": "源代码 · {path}",
  "Live preview": "实时预览",
  "Saved version": "已保存版本",
  "Site preview": "站点预览",

  // ── visual-editor ────────────────────────────────────────────────────────────
  "This page blocked the editing script (usually because the artifact ships its own Content-Security-Policy, or its script rewrote the whole document), so visual editing cannot be used. Please use Edit source instead.":
    "这个页面阻止了编辑脚本运行（常见原因：产物自带 Content-Security-Policy，或它的脚本重写了整个文档），没法用可视化编辑。请改用「源码编辑」。",
  "This text is a copy made by the page script (typical of thumbnails and preview panes); changing it would not touch the source. Edit the one in the main content instead — that one can be double-clicked and edited directly.":
    "这段文字是页面脚本复制出来的副本（常见于缩略图、预览面板这类地方），改它不会动到源码——请在正文里的那一处改，那里是可以直接双击编辑的。",
  "The original of this text has been replaced on the page by its script; only a copy remains, so the change cannot be written back safely. Please use Edit source to change it.":
    "这段文字的原件已经被页面脚本从页面上换掉了，眼下留在页面上的只是副本，改动没法安全写回——请用「源码编辑」修改它。",
  "The runtime structure of the element holding this text does not match the source (the page script inserted nodes), so the change cannot be written back safely. Please use Edit source to change it.":
    "这段文字所在元素的运行时结构和源码对不上（页面脚本插过节点），改动没法安全写回——请用「源码编辑」修改它。",
  "This text cannot currently be mapped back to the source. You can change it with Edit source.":
    "这段文字暂时无法定位回源码，可以用「源码编辑」修改它。",
  "{count} passages generated by the page script": "{count} 段由页面脚本生成",
  "{count} passages whose structure does not match the source": "{count} 段的结构和源码对不上",
  "{count} passages left only as copies made by a script": "{count} 段只剩脚本复制出来的副本",
  ", ": "、",
  "This page has no text that can be edited by double-clicking ({reasons}); visual editing cannot reach any passage in the source. Please use Edit source.":
    "这一页没有能双击改写的文字（{reasons}），可视化编辑改不到源码里的任何一段——请用「源码编辑」。",
  "No editable text was found on this page. Please use Edit source.": "这一页没有找到任何可编辑的文字——请用「源码编辑」。",
  "{count} passages on this page can be edited; another {reasons} need Edit source.":
    "本页 {count} 段文字可改；另有 {reasons}，需用「源码编辑」修改。",
  "All {count} passages on this page can be edited directly.": "本页 {count} 段文字都可以直接改。",
  "This site was updated elsewhere. Refresh the page before editing": "站点已在别处更新，请刷新页面后再编辑",
  "Saved. Not written back: {missed}. The editor was reloaded with the new version, so those passages have reverted to the original source text. Please use Edit source to change them.":
    "已保存。另有 {missed} 处没能写回源码，编辑面已按新版本重载——那几处已回退成源码里的原文，请改用「源码编辑」修改。",
  "Changes saved: {count}. Not written back: {missed} (the text in the source no longer matches); they remain marked as unsaved. Please use Edit source to change them.":
    "已保存 {count} 处。另有 {missed} 处没能写回源码（源码里那几段文字已经对不上了），它们仍标记为未保存——请改用「源码编辑」修改这几处。",
  "This site can only be edited with Edit source.": "这个站点只能用源码编辑。",
  "Loading failed ({status})": "加载失败（{status}）",
  "Loading failed": "加载失败",
  "The editor is not responding. Please try again": "编辑器无响应，请重试",
  "These changes could not be mapped back to the source. Please use Edit source instead": "这些改动暂时没能定位回源码，请改用「源码编辑」修改",
  "No changes yet": "还没有改动",
  "Previewing: the page has its own interactions back · Switch back to Edit to change text": "预览中：页面交互已交还给它自己 · 切回「编辑」才能改字",
  "Double-click any text to rewrite it · Enter to confirm · Esc to cancel": "双击任意文字即可改写 · 回车确认 · Esc 撤销",
  "Edit / Preview": "编辑 / 预览",
  "Hand the page back to the artifact in place: its own keys, clicks, and controls come back; unsaved changes are kept":
    "就地把页面交还给产物：它自己的按键、点击、控件都恢复；未保存的改动会留着",
  "Preview": "预览",
  "Visual editing": "可视化编辑",
  "Visual editing failed to load": "可视化编辑载入失败",
  "Retry": "重试",
  "Switched to Edit source": "已切换到源码编辑",
  "Use Edit source instead": "改用源码编辑",
  "This page can only be edited with Edit source": "这一页只能用源码编辑",
  "Loading visual editing…": "正在载入可视化编辑…",
  "Still waiting for this page to be ready. You can also": "还在等这个页面就绪。也可以",
  "use Edit source instead": "改用源码编辑",

  // ── assistant (mount copy; prompts are what the reader sends) ─────
  "Let AI edit this artifact": "让 AI 编辑这份产物",
  "Ask AI": "问问 AI",
  "Explain selection": "解释选中的内容",
  "Explain what I selected on the page.": "解释我在页面上选中的内容。",
  "Modify this artifact": "修改这个产物",
  "Modify this artifact according to my selection and instructions, then publish it as a new version. First read the manual at artifactHub.skill in the context (it includes the steps to obtain a publish token) and follow it.":
    "根据我的圈选和要求修改这份产物，改好后发布为新版本。先读上下文 artifactHub.skill 那份手册（含取发布令牌的步骤），按它操作。",
  "Summarize artifact": "总结这份产物",
  "Summarize the key points of this artifact.": "总结这份产物的要点。",
  "Summarize content": "总结这份内容",
  "Summarize the key points of this content.": "总结这份内容的要点。",
  "Explain": "解释",
  "Edit this": "改这段",
  "Modify this artifact according to my selection, then publish it as a new version. First read the manual at artifactHub.skill in the context (it includes the steps to obtain a publish token) and follow it.":
    "根据我的圈选修改这份产物，改好后发布为新版本。先读上下文 artifactHub.skill 那份手册（含取发布令牌的步骤），按它操作。",
};
