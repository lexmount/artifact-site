import type { Messages } from "@/lib/i18n";

/** Pages under src/app (home, not-found, /activate, /me, /for-agents, /publish-from-page, /s/[slug],
 *  /s/[slug]/edit, /v/[token]). Keys are the English source strings exactly as written in code. */
export const pages: Messages = {
  // Shared header
  "artifact-site home": "artifact-site 首页",
  "Back to home": "回到首页",
  "Loading…": "加载中…",
  "Sign in": "登录",
  "Sign-in not enabled": "未启用登录",
  "Sign-in required": "需要登录",
  "This deployment has no identity provider yet": "这个部署还没有接入身份",
  "Single file": "单文件",
  "Document": "文档",
  "Folder": "文件夹",

  // Home
  "link": "链接",
  "HTML, folders, PDFs and Office documents all become shareable links.": "HTML、文件夹、PDF 或 Office 文档，都能变成可分享的链接。",
  "Publish this project's output (a web page or a PDF/Office document) to artifact-site. Publishing guide: {url}":
    "请把当前项目的产物（网页或 PDF/Office 文档）发布到 artifact-site，发布手册：{url}",

  // Not found
  "Site not found — artifact-site": "站点未找到 — artifact-site",
  "Site not found": "站点未找到",
  "The site this link points to does not exist or has been deleted.": "这个链接指向的站点不存在，或者已经被删除。",

  // /activate
  "Device authorization": "设备授权",
  "Authorization failed": "授权失败",
  "Network error. Please try again later.": "网络错误，稍后再试。",
  "Without an identity there are no publish tokens.": "没有身份就没有发布令牌。",
  "Sign in to complete device authorization": "登录后完成设备授权",
  "A terminal / agent session is asking to publish as you. Sign in to confirm.": "一个终端 / agent 会话正在请求以你的身份发布。登录后确认。",
  "Allow this session to publish as you?": "允许这个会话以你的身份发布？",
  "A terminal / agent session is requesting a publish token. If you allow it, the sites it publishes belong to {name}; the token is long-lived and can be revoked at any time from your account page.":
    "一个终端 / agent 会话请求获得发布令牌。允许后，它发布的站点直接归到{name}名下，令牌长期有效、可随时在个人中心吊销。",
  "Only click Allow when the code comes from a session you started yourself": "只有当授权码来自你自己发起的会话时才点允许",
  "{rule} — never authorize a code someone else sent you.": "{rule}——别替任何别人发来的码授权。",
  "Authorization code": "授权码",
  "Allow": "允许",
  "Authorized": "已授权",
  "Back to your terminal": "回到你的终端",
  "Authorization is complete; that side will pick up the token and continue within seconds. You can close this page. The token can be revoked at any time from your {accountPage}.":
    "授权已完成，那边几秒内会自动拿到令牌并继续。此页可以关掉了；令牌可在{accountPage}随时吊销。",
  "account page": "个人中心",

  // /me
  "Account views": "个人中心视图",
  "Created by me": "我创建的",
  "I can edit": "我可以编辑的",
  "Publish tokens": "发布令牌",

  "Failed to load": "加载失败",
  "Previous": "上一页",
  "Next": "下一页",

  // /publish-from-page
  "Publish the page you are looking at — artifact-site": "发布正在看的网页 — artifact-site",
  "Drag a button to your bookmarks bar; after that any page (including local file:// files) can be published as a shareable link in one click.":
    "把一个按钮拖到书签栏，之后任何页面（含本地 file:// 文件）都能一键发布成可分享的链接。",

  // /for-agents
  "Publish skill — for AI / agents": "发布技能 — 给 AI / Agent",
  "Send one address to your AI and it can publish front-end output as a link you can share and edit in place.":
    "把一个地址发给你的 AI，它就能把前端产物发布成可分享、可在线编辑的链接。",

  // /s/[slug]/edit
  "Edit {title} — artifact-site": "编辑 {title} — artifact-site",

  // /v/[token]
  "This link is no longer valid — artifact-site": "链接已失效 — artifact-site",
  "Protected content, visible after signing in · artifact-site": "受保护的内容，登录可见 · artifact-site",
  "Protected content, visible to invited members only · artifact-site": "受保护的内容，仅指定成员可见 · artifact-site",
  "Protected content, passcode required · artifact-site": "受保护的内容，需访问码 · artifact-site",
  "This link is no longer valid": "链接已失效",
  "This share link does not exist, has been revoked, or has expired. Ask the person who shared it for a new link.":
    "这个分享链接不存在、已被撤销，或者已经过期。请向分享给你的人索取新的链接。",
  "Sign in to view": "需要登录后查看",
  "The person who shared this link made it visible after signing in. Sign in with your account to open it.":
    "分享者把这个链接设置为「登录可见」。用你的账号登录后即可打开。",
  "This deployment has no sign-in configured yet. Ask the person who shared it for a different link.":
    "这个部署还没有接入登录，请联系分享者换一个链接。",
  "Your account is not on this link's access list": "你的账号不在此链接的可见范围内",
  "The person who shared this link limited it to invited members. If you need access, ask them to add you.":
    "分享者把这个链接限定给了指定成员。如果你需要访问，请联系分享给你链接的人把你加进去。",
  "Incorrect passcode. Please try again.": "访问码不正确，请再试一次。",
  "Too many attempts. Please try again later.": "尝试次数过多，请稍后再试。",
  "Please enter the passcode.": "请输入访问码。",
  "Enter the passcode": "请输入访问码",
  "The person who shared this link protected it with a passcode. Enter it to view; you will not be asked again for 12 hours.":
    "分享者为这个链接设置了访问码。输入后即可查看，之后 12 小时内不用再输。",
  "Passcode": "访问码",
  "View": "查看",
  "Shared output": "分享的产物",
  "Read-only share": "只读分享",
  "Open in a new tab": "在新标签打开",
};
