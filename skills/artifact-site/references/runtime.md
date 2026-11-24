# Hosted runtime

`GET /api/auth/me` advertises `uploadLimits` (`maxBytes`, `maxFileBytes`, `maxFiles`) in bytes/count, including for anonymous callers. Read these deployment-specific values before preflight or local ZIP extraction; the defaults below can be raised by the operator.

Works are treated as untrusted content and run in a `sandbox`, an isolated environment **without `allow-same-origin`** (an opaque origin). Everything below is a tested conclusion.

### Package and legacy website paths

Servers advertising `uploadLimits.packageUploads` accept directory-first packages without
an HTML entry. `packagePaths: 1` additionally permits ordinary hidden paths, `.git` and
`node_modules`. Package HTML/HTM and CSS resolve relative resources from the current file's
directory; root-relative markup/CSS resources stay within the package. Safe authored base
paths are respected inside that namespace. Package directories retain their structure.
Use relative resources for portability and do not depend on arbitrary JavaScript strings
being rewritten. The publishing topic describes supported file readers and original downloads.

The exclusion and flattening rules below apply to legacy website uploads, not packages with
`packagePaths: 1`. A package server lacking that capability still needs legacy path filtering.

### Legacy website packaging

`node_modules` and `.git` (at any depth, case-insensitive) make **the entire upload fail with a 400** — a rejection, not a skip:

```bash
zip -r site.zip dist -x '*/node_modules/*' '*/.git/*'
```

In an environment without the `zip` command (common in cloud sandboxes), use the standard library instead. Note that `python3 -m zipfile -c` does not support exclusion patterns,
while exclusion is a hard requirement (one stray `node_modules` and the whole package is a 400), so this needs the script rather than that one-liner:

```bash
python3 - <<'PY'
import pathlib, zipfile
SKIP = {"node_modules", ".git", "__MACOSX"}
root = pathlib.Path("dist")
with zipfile.ZipFile("site.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for f in root.rglob("*"):
        if f.is_file() and not SKIP & set(f.parts):
            z.write(f, f.relative_to(root.parent))
PY
```

`__MACOSX`, `.DS_Store` and `Thumbs.db` are stripped automatically; no need to deal with them.

### Paths and references

- For legacy websites, `/assets/x.js` resolves to the platform root. Configure static builds with relative resource URLs (Vite `base:'./'`, CRA `"homepage":"."`) before uploading. Package markup/CSS has the scoped resolution described above.
- Resource URLs may use ordinary query parameters such as `styles.css?v=hash`, `app.js?t=timestamp`, or `image.svg?share=value`; these do not select platform versions or credentials. The unkeyed preview entry URL still accepts platform `v`/`share` controls. Platform links to the entry or a specific file use reserved `__artifact_version`, `__artifact_share`, and `__artifact_image` parameters (version/share controls take precedence over their legacy entry equivalents); do not use the `__artifact_` namespace for artifact-owned parameters. A path-scoped preview credential always pins resources to its authorized version.
- Legacy website previews inject the published root as `<base>`, ahead of any authored base. In that mode `./sub.css` in `sub/page.html` refers to root `sub.css`; write paths relative to the published root. Package previews use the current file's directory instead.
- Legacy previews block dot-leading paths; packages with `packagePaths: 1` permit ordinary hidden paths while keeping internal platform files inaccessible.
- A single wrapper directory is flattened for legacy website uploads (`dist/index.html` → `index.html`); package uploads preserve the directory structure.

### Files and the entry

- Packages open a generated file directory and need no HTML entry; `.html` and `.htm` open as sandboxed HTML. Legacy websites choose root `index.html`, then the only `.html`, then a nested `index.html`; include root `index.html` for predictable legacy behavior.
- Compile JSX/TypeScript and other source formats before publication. An unknown file type is not an executable script; it falls back to a file reader or download. Package readers support text, Markdown, CSV/TSV, images, media and PDFs as described in the publishing topic.
- A literal `<head>` tag is optional. Preview script injection preserves the existing doctype, including when HTML omits `<html>` or `<head>`. Include `<!doctype html>` yourself for predictable standards-mode rendering.

### APIs unavailable at runtime (all throw SecurityError)

- `document.cookie` (both read and write throw)
- `indexedDB.open()` (`typeof indexedDB` is object, **but any open throws**)
- `caches` — reading the property itself throws
- `navigator.serviceWorker` — reading the property itself throws; the whole PWA/offline-cache stack is unusable
- `new Worker('./w.js')` — the URL form throws; **`new Worker(URL.createObjectURL(blob))` works**
- Cross-window access (`parent` / `top` / `opener`)
- `fetch` of the platform's own API (e.g. `/api/sites`) — TypeError; only `/api/preview/*` carries CORS headers

### Navigation

- External HTTP(S) anchors in the main, shared, presentation and direct-preview viewers open
  ordinary new tabs on a user click, without a confirmation dialog. The platform keeps the
  artifact sandboxed and opens the external tab without an opener or referrer. Use native
  anchors; scripted `window.open()`, downloads and links handled with `preventDefault()`
  retain their own behavior. Platform links still use their existing confirmation.
- Top-level browser visits to HTML `/api/preview/` and direct-delivery resources enter a trusted
  preview shell, retaining the resource query, version/access grant and fragment. Iframe
  loads, fetches and explicit downloads keep the resource endpoint behavior. Continue to
  share `/s/<slug>` or `/v/<token>` URLs rather than internal resource capabilities.

- Links to a PDF in the uploaded tree open the platform's PDF.js reader; use relative file
  paths. Byte fetches and Range requests still return the PDF, and the reader offers a download.
- Ordinary links to the platform's `/`, `/me`, `/explore`, `/c/<token>`, `/s/<slug>`, or
  `/v/<token>` routes ask the reader to continue through the host so browser sign-in works.
  Use the deployment's base path when present. Main, shared and presentation viewers support
  same-tab links, `target="_blank"`, middle-click and Ctrl/Cmd/Shift-click. Collection search and
  folder filters, work version/collection context, presentation mode, and comment deep links
  (`thread`, `message`, `comments=1` or `comments=all`, and `#comment=<thread-id>`) are preserved after validation.
  Links that stop event propagation still use the host; links that cancel activation with
  `preventDefault()` keep their own behavior.
  Prefer ordinary anchors: direct `window.open()` calls and the browser's context-menu commands
  bypass this click bridge and can create tabs that inherit the sandbox, even after reload.
  An already affected tab must be reopened from outside the preview. Do not embed the platform
  UI in the work or weaken sandbox permissions to share its login.

### Usable but not persistent

`localStorage` / `sessionStorage` are backed by an in-memory shim: **calls do not throw, but everything resets on every load**, and only `getItem/setItem/removeItem/clear/key/length` are implemented (property-style writes like `localStorage.foo = 'x'` are not remembered). Works must not rely on them to keep user data.

`Notification` exists but permission requests are dropped; do not treat it as a feature switch.

### Works normally

Inline and external `<script>`, `type="module"` module scripts, dynamic `import()`, JS/CSS/fonts from external CDNs, `fetch` of relative in-site assets and external APIs, `crypto`, form submission, popups, downloads.

> Operations note: if the deployment sets `CSP_CONNECT_SRC`, it is an **exclusive allow list** — once enabled, a work's `fetch` of its own files is cut off too. Either leave it unset, or include the work's own origin in it.

### Size, count, rate

- One version totals at most **300MB**, a single file **250MB**, at most **2000** files (deployment-adjustable); but the one-shot upload endpoints take **24MB per request**, beyond which use the "chunked upload" section
- Rate limiting defaults to roughly 20 burst / 30 per minute, **counted per client IP, with creation/edit/fork sharing the same allowance**. Several agents behind the same egress IP crowd each other out
