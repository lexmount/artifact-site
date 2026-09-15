# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Email **security@lexmount.com** with a
description, steps to reproduce, and the version (or commit) you tested. We aim to acknowledge
within 3 business days and to ship a fix or a documented mitigation within 30 days for
confirmed issues. Credit is given in the release notes unless you prefer otherwise.

## What this project protects against

artifact-site hosts **untrusted HTML uploaded by users** and serves it to other users. The threat
model is: an uploader is hostile; a viewer must not be harmed by opening a link.

- **Every artifact renders inside a sandboxed iframe without `allow-same-origin`.** The preview
  endpoint also sends a `Content-Security-Policy: sandbox …` header, so the document has an
  opaque origin even if the iframe attribute is somehow bypassed. Hosted code cannot read the
  platform's cookies, storage, or DOM, and cannot make same-origin requests to the API.
- **Hosted pages may reach the network, and the operator can restrict that.** By default the
  preview CSP carries only the `sandbox` directive, so an artifact can `fetch` its own files and
  external APIs — that is what dashboards and demos need. Setting `CSP_CONNECT_SRC` turns on an
  exclusive `connect-src` allow list (include the deployment's own origin, or artifacts lose
  access to their own assets). Either way the artifact cannot reach the platform API: it has an
  opaque origin, so it holds no cookies and no session.
- **Path handling is defensive end to end**: zip entries, upload paths, and preview paths are
  rejected on `..`, dot segments, absolute paths, symlinks, and any realpath escaping the version
  directory. Zip declared sizes are checked before decompression (zip-bomb guard); per-version,
  per-file, and file-count limits apply to every upload route.
- **Writes are authenticated and CSRF-guarded.** Cookie-authenticated mutations must carry an
  `Origin` matching `ARTIFACT_PUBLIC_URL`; bearer tokens (publish tokens, OAuth access tokens,
  the admin token) are exempt because they are not ambient. Session cookies are `HttpOnly`,
  `SameSite=Lax`, and use the `__Host-` prefix over HTTPS. The database stores only SHA-256
  hashes of session, publish-token and OAuth token secrets.
- **The OAuth authorization server fetches exactly one kind of URL a stranger chose** — a
  client's metadata document — and only over https, from a public host that resolves to public
  addresses, without following redirects, within a short deadline and a small size. A client's
  redirect address is verified against its registration before any redirect happens; an
  unverifiable request gets a page, never a redirect. A return address is https, a loopback
  listener, or a native application's scheme in the reverse-domain shape (plus `cursor:` and
  `vscode:`); every other scheme is refused, since registration is open and a redirect to a scheme
  runs whatever handles it on the person's machine. The consent page names the client's host and
  the return address, refuses to be framed, and a token session cannot answer it. Authorization codes are single
  use (a replay revokes what it produced); refresh tokens rotate (a replay ends the grant); every
  token is bound to the deployment address it was issued for.
- **Write routes are rate limited** per client (first `X-Forwarded-For` hop). The app port must
  therefore only be reachable through the reverse proxy that sets that header.
- **Referrer is suppressed** (`Referrer-Policy: no-referrer`) so an edit-token URL never leaks
  into a hosted page's `document.referrer`.

## What it does not protect against

- A hosted page can still do anything a sandboxed page can: show phishing content, run
  CPU-heavy scripts, open pop-ups (`allow-popups`), or download files (`allow-downloads`).
  Who may publish is an operator decision (`ARTIFACT_CREATE_POLICY`); on the public internet do
  not leave it `open`.
- Viewing is by unguessable link. A link, once shared, is a capability; "unlisted" and "private"
  are visibility defaults and share policies, not DRM.
- The in-process rate limiter is per replica. N replicas allow roughly N× the configured rate.
- Office document conversion sends the uploaded file to Gotenberg. Run Gotenberg on an isolated
  network segment reachable only from the app.

## Supported versions

Security fixes land on `main` and in the latest tagged release. Older tags are not patched.
