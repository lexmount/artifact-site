# Authentication

### Step one: reuse or authorize the current Agent connection

Tokens are issued **per server**: one obtained on `https://a.example` is meaningless on `https://b.example`. Look for this server's token, in this order — the environment first (sandboxes and CI inject it there, and a fresh HOME every session would otherwise mean a sign-in every session), then the per-host file, then the old single-file location:

```bash
HOST=$(printf %s "$BASE" | sed -E 's#^https?://##; s#/.*$##')
TOKEN="${ARTIFACT_SITE_TOKEN:-}"
[ -z "$TOKEN" ] && TOKEN="${ARTIFACT_HUB_TOKEN:-}"                                          # the product's previous name, still honoured
[ -z "$TOKEN" ] && TOKEN=$(cat "$HOME/.config/artifact-site/tokens/$HOST" 2>/dev/null)
[ -z "$TOKEN" ] && TOKEN=$(cat "$HOME/.config/artifact-hub/tokens/$HOST" 2>/dev/null)    # previous name
[ -z "$TOKEN" ] && TOKEN=$(cat "$HOME/.config/artifact-site/token" 2>/dev/null)   # legacy, pre per-host
[ -z "$TOKEN" ] && TOKEN=$(cat "$HOME/.config/artifact-hub/token" 2>/dev/null)    # legacy, previous name
```

**Then verify it before uploading anything** — it is one cheap call, and it tells you whose identity you are about to publish under:

```bash
curl -sS -i "$BASE/api/auth/me" -H "authorization: Bearer $TOKEN"
# 200 {"user":{"email":"…"},…}          → good: tell the user which account the site will belong to
# 401 {"error":"…","code":"token_unknown"} → this server has never seen the token: it belongs to ANOTHER deployment.
#                                            Do the device authorisation below for $BASE and store the result under
#                                            tokens/$HOST. Do NOT delete or overwrite the other server's token.
# 401 {"error":"…","code":"token_revoked"} → revoked here (account page, or the account was disabled): authorise again.
```

**Present and verified** → every request from here on carries `-H "authorization: Bearer $TOKEN"`. The published site **belongs to the user directly** (visible and manageable in their account page); no cookie is needed and no claiming afterwards.

**Missing or invalid credentials** → authorize the current Agent connection. Browser sign-in alone does not authenticate CLI/MCP. Reuse an already valid connection; for a native MCP connector, use its native OAuth connection flow instead of creating a separate device credential. A 403 or network/server error is not proof of missing identity: diagnose it before asking the user to sign in again.

For CLI/direct HTTP without a valid personal credential, use device authorization below. If `/api/auth/me` reports `oidcEnabled:false`, browser sign-in cannot complete: explain that this deployment needs an operator-configured sign-in or credential, or offer browser upload where policy permits. Never invent a login link or ask for a token in chat.

```bash
curl -sS -i -X POST "$BASE/api/device/start"
# → {"device_code":"…","user_code":"XXXX-XXXX","verification_url":"…",
#    "verification_url_manual":"…","user_message":"…","interval":5,"expires_in":600}
```

**Show the returned authorization link in your user-facing reply before polling.** Localize `user_message` into the user's language; preserve the exact `verification_url`, `verification_url_manual`, `user_code`, and expiry. Render a clickable link, never leave it only in tool output. Explain what happens next, for example:

> Please [sign in and authorize this connection](<verification_url>). Once you approve, I'll continue hosting and sharing the work you requested. While this connection remains authorized, later requested hosting and sharing operations can use it without signing in again.

Also include the returned manual URL, code and expiry as a fallback. Do not promise permanent authorization, access on other devices, or automatic public sharing. On the user's computer, you may open the returned URL through the available browser tool; the visible link is still required in headless or remote environments.

Retain the pending artifact, requested operation and sharing scope while waiting. Poll using the response's `interval` and `expires_in` (fallback: 5 seconds and 600 seconds if omitted), respecting rate-limit or slower-poll responses. Tell the user that approval will let you continue without them pasting the prompt again:

```bash
curl -sS -X POST "$BASE/api/device/poll" -H 'content-type: application/json' \
  -d '{"device_code":"<device_code returned by start>"}'
# not clicked yet → {"status":"pending"}; allowed → {"status":"approved","token":"ahp_…","user":{"email":"…"}}
```

Once you have the `token`, **store it immediately — the plaintext is shown only this once** — under this server's host, report `user.email` so the user can confirm the bound identity, and automatically resume the exact pending task within the user's request. Do not ask the user to repeat the prompt or approve the same task again:

```bash
mkdir -p "$HOME/.config/artifact-site/tokens" && printf %s '<token>' > "$HOME/.config/artifact-site/tokens/$HOST" && chmod 600 "$HOME/.config/artifact-site/tokens/$HOST"
```

If the authorization expires, stop polling and retain the pending task. Offer a fresh authorization link; on retry, start a new grant without asking the user to restate the work. Revoked credentials require reconnection. A denied authorization must not trigger repeated sign-in requests.

Credentials can be reused only while valid in the current client/environment. If `$HOME` does not survive between sessions, explain that limitation; never promise that approval covers future sandboxes or devices. Authentication does not grant consent to broaden artifact access: default to private and, if the requested audience is unclear, ask once before changing sharing.

Offer anonymous publishing only where deployment policy permits and the user **explicitly chooses it**. Declining authorization or letting it expire is not consent to publish anonymously: modifications rely on a cookie, and ownership can be transferred by its authorized owner or administrator (see below). A deployment may also give anonymous sites an expiry: the create response then carries `expiresAt` (epoch ms; null = no clock) — say so when delivering the link, and explain original-browser sign-in or authorized ownership transfer.

### Attaching an unowned site to an account

**A site published with a personal token is under that user's account from birth; skip this section.** Anonymous publications, operator-token publications and historical unowned sites may need ownership assignment or transfer — ask proactively when delivering: "Do you want to attach this site to your account?" If not, stop here; if yes, use the creating session to transfer ownership, or ask an administrator to assign an unowned site as described below. **Do not improvise with "fork a copy and delete the old site"**: a fork copies only the current version, the history is cut off, the slug changes, and every link already sent out becomes invalid.

**Claim from My sites in the creating browser.** Sign in there, open the browser-artifact claim notice, review the default publishing tenant shown, then explicitly confirm adding the artifacts to the account. This uses the original anonymous cookie plus the account session; neither a token nor a localStorage key is ownership proof. If the creating cookie is unavailable, ask an administrator to assign the unowned site.

An account owner can transfer an already-owned site through `POST /api/sites/<slug>/ownership` with `{"email":"verified account email"}`. The destination must be an active member of the same tenant. Transfer retires anonymous tokens without changing the slug, versions, visibility or shares. Disown is disabled (`410`).

Open claiming by site address is disabled. Do not send `/me#claim=…` links or call
`POST /api/sites/:slug/claim` (410). Personal-token publications already belong to that user.
Signing in from the original creating browser can still adopt that browser's own anonymous sites.

#### If the creating session is lost: ask the user to contact an administrator

For an operator-created or historical unowned site, tell the user to ask an administrator to
open **Administration → Site actions**, load the known site address or ID with a reason,
then choose **Assign owner** and enter the verified email of their existing, active account
and a reason for the assignment. Provide the site address and intended recipient email so the administrator can
check the request. This keeps the original address and version history; existing owners cannot
be overwritten through assignment.

A personal Agent token does not carry email-administrator privileges. Do not retry the retired
claim endpoint or ask the user to paste an administrator credential into chat. Email administrators
can use these forms even when PUBLISH_API_TOKEN is unset. Administrator API instructions are in
SELFHOST.md; this recovery step requires an authorized administrator.
