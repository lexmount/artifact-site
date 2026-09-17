---
name: artifact-site
description: Publish finished HTML, static build folders, ZIPs, PDFs and Office documents to an artifact-site server, or find, read and update work already hosted there. Use when the user asks to publish or manage content on artifact-site; this skill does not provision a server or deploy application backends.
---

# Publish and manage work on artifact-site

Use the user's artifact-site deployment to turn finished work into a shareable link, or to find and update an existing site without changing its address.

## Get the deployment's current guide

Determine the server base URL from the user's request or an existing artifact-site configuration. If it is missing or ambiguous, ask for it; do not default to the public demo. A cloud agent cannot reach `127.0.0.1` on the user's computer.

Read `<base-url>/for-agents.md` before publishing or updating. That guide is served by the target deployment with its address and API contract; prefer it over remembered endpoints or a copy from this repository. If it cannot be retrieved, report the access problem instead of guessing the publishing API. Refresh it when its `skill_version` differs from the server's `X-Artifact-Site-Skill-Version` response header.

## Choose an available interface

- **CLI:** install with `npm install -g @artifact-site/cli` (Node 24+). Follow the deployment's `/for-agents#cli` instructions for authentication. With OIDC configured, `artifact-site login --base <base-url>` starts device sign-in. The user completes sign-in in their own browser.
- **Remote MCP:** use the configured connection to `<base-url>/mcp`. OAuth-capable clients sign in through the server's consent page; other clients use a personal token. Follow `/for-agents#mcp` for the deployment's configuration. CLI installation is unnecessary when MCP is available.
- **HTTP:** when neither interface is available, follow the current `/for-agents.md` contract exactly.

Use the deployment's supported authentication and existing credentials. Do not ask the user to paste passwords or administrator credentials into chat. Do not silently switch to anonymous publication after an authentication failure.

## Prepare and publish

Build source projects into static output first; artifact-site does not run builds or application backends. Keep asset references relative to the site root, exclude `.git` and `node_modules`, and check the current guide's file and size limits. Hosted HTML runs in a sandbox without the platform's login session; browser persistence and external API access have restrictions. PDF is viewable online; Office preview requires the deployment's Gotenberg conversion service.

Respect the user's requested audience. CLI and MCP publication create a public share by default. Use `--share none` (CLI) or `share: false` (MCP) when publication should remain unshared, then configure any requested access through the supported sharing interface. Do not broaden access to work around a failed verification.

Typical CLI operations after configuration:

```bash
artifact-site publish dist/ --title "Q3 dashboard"
artifact-site find "quota"
artifact-site read YOUR_SITE_SLUG
```

For updates, identify the intended existing site, read its current content and version, and follow the deployment's update instructions. Preserve the site's address. Use the supported optimistic-concurrency check; on a conflict, read the new version and reconcile rather than forcing an overwrite. Document updates re-upload the whole file.

## Verify and deliver

Check the returned link using the intended audience's access, not merely the owner's authenticated session. For a public link, verify without credentials; for a restricted link, verify the expected access gate and report any audience check you cannot perform. When possible, open the preview to catch blank pages or broken assets.

Return the verified viewing or sharing URL and the site slug for later updates. State any configured expiry or unverified access condition. Keep tokens and anonymous-session cookies out of the response; if anonymous publishing was explicitly chosen, preserve its credentials locally and explain where they are stored.
