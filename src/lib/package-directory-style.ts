/** Self-contained preview CSS mirrors the platform's light tokens in globals.css.
 * It stays inside the sandbox and does not load authenticated host stylesheets. */
export const packageDirectoryStyle = `
:root{color-scheme:light;--bg:#fdfdfd;--ink:#171a17;--muted:#626862;--line:#e3e7e1;--green:#e4edc8;--hover:#f3f5ef;--focus:#557341;--font-ui:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif}

*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 var(--font-ui);-webkit-font-smoothing:antialiased}
main{max-width:1040px;margin:auto;padding:40px 32px 64px}
h1{margin:0;font-size:24px;line-height:1.3;font-weight:600;letter-spacing:-.02em;overflow-wrap:anywhere}
header p{margin:8px 0 0;color:var(--muted);font-size:13px}
.toolbar{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:24px}
.actions{display:flex;gap:8px;flex-shrink:0}
button{font:500 13px/1.4 var(--font-ui);color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:7px;min-height:36px;padding:8px 12px;cursor:pointer}
button:hover{background:var(--hover)}
button:active{background:var(--green)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
::selection{background:var(--green)}
.tree{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:12px 0}
ul{list-style:none;margin:0;padding:0}
ul ul{margin-left:13px;padding-left:22px;border-left:1px solid var(--line)}
summary,.file-row{display:flex;align-items:center;gap:10px;min-height:40px;padding:8px 6px;border-radius:7px;font-size:14px}
summary{cursor:pointer;list-style:none;font-weight:500}
summary::-webkit-details-marker{display:none}
.chevron{width:12px;height:12px;flex:none;color:var(--muted)}
details[open]>summary>.chevron{transform:rotate(90deg)}
summary:hover,a.file-row:hover{background:var(--hover)}
.icon{width:18px;height:18px;flex:none;color:var(--muted)}
.file-row{padding-left:28px;text-decoration:none;color:inherit}
.name{min-width:0;overflow-wrap:anywhere}
a.file-row .name{text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:4px}
a.file-row:hover .name{text-decoration-color:var(--focus)}
a.file-row .icon{color:var(--focus)}
small{margin-left:auto;padding-left:12px;flex:none;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.empty{padding:8px 28px;color:var(--muted);font-size:13px}

@media(max-width:600px){main{padding:24px 16px 40px}
.toolbar{align-items:flex-start;flex-direction:column;gap:16px;margin-bottom:20px}
h1{font-size:21px}
button{min-height:40px}
.file-row,summary{min-height:44px}
ul ul{padding-left:14px}
small{font-size:11px;padding-left:4px}
.actions{flex-wrap:wrap}
}

`;
