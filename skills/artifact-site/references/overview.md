# Publishing artifacts to artifact-site

Help the user host an artifact and collaborate around it through a `/s/<slug>` link. The user may have existing work, an idea, or only this copied prompt. **There is no build step** — the artifact is uploaded as is and served as is; the platform does not rewrite your code.

**Base URL**: written as `$BASE` below. The default is `https://artifact-site.example.com` (the platform rewrites it to its own address when it serves this file; if you still see example.com, this file did not come from the platform — ask the user for the address). If the user explicitly gives another address, use the user's. Strip the trailing `/` before calling the API or building share links, to avoid double slashes.

## Start with the user's intent

Follow this order: **identify the work → authorize when needed → continue the requested task → return the link and its actual access state**. Respond in the user's language, including when API messages are English.

| Conversation context | Next action |
| --- | --- |
| One clearly identified artifact | Use it; do not ask the user to identify it again. Inspect only relevant files when needed. |
| Several plausible artifacts | Ask one short question naming the candidates. |
| Only the copied prompt, with no artifact or request | Ask what the user wants to host, with examples; wait for the answer. |
| An idea, without existing files | Offer to create it first. Create only when the user's request authorizes that work. |
| An explicitly selected file is missing | Explain which selected file is unavailable and ask for the correct file or location. |
| An existing hosted artifact needs changes | Update that artifact and retain its main URL; do not create a duplicate. |

For a new, empty conversation, say the equivalent of:

> What would you like me to host? It could be a web page, report, presentation or another document. You can share an existing file, or tell me what you want to make so we can create it first, then host and share it.

Do not treat the current directory as the user's chosen artifact. Do not scan unrelated directories, announce "no artifact found in /some/path", invent a demo, or initiate authorization just because the generic prompt was pasted. If both intent and identity are missing, clarify intent first. Once the work is identified and ready to host, check the current Agent connection and authorize only if needed.

### Creation, sharing and discovery

Creating an artifact does not authorize sharing it. Web, CLI and MCP default to private creation; always inspect and report the returned `visibility` (administrators can explicitly override deployment defaults). Return the canonical `/s/<slug>` URL. Do not automatically create `/v/` links.

| User intent | Action |
| --- | --- |
| Create a report / give me its link | Create privately and state that only authorized people can open it |
| Share so anyone with the link can open it | Set `visibility: unlisted`; return the same main URL |
| Publish to Explore / make searchable publicly | Set `visibility: public`, only on explicit request |
| Make private again | Set `visibility: private`; independent share links remain active |
| Separate customer review / password / expiry | Explicit advanced share; its comments stay isolated |
| Stop all external sharing | Set private, list independent shares and revoke the applicable links too |

MCP: `artifact_site_publish` no longer auto-shares. Use `artifact_site_get_visibility` and `artifact_site_set_visibility`. CLI: `artifact-site visibility <slug> [private|unlisted|public]`. HTTP: `GET/PUT /api/sites/<slug>/sharing`, body `{"visibility":"unlisted"}` for ordinary sharing. Only sharing managers may change access.

If creation succeeds but changing access fails, report the existing artifact and retry the state change; never publish a duplicate. Updating content preserves access. Copying a URL never changes access. `unlisted` works are absent from unrelated users' searches and Explore; owners and authorized collaborators can still find their work. Knowing or opening a share link does not make its private artifact discoverable.

New main discussions let artifact readers see comments and require sign-in to post. Pausing comments stops new comments/replies but preserves reading. Historical discussions retain their original visibility. Advanced shares keep separate discussions and their existing view/comment/edit permissions. Version boundaries are unchanged.

The old explicit `share` publish parameter and CLI `--share` remain compatibility options for advanced independent links, with no default share. `share: public` is NOT the same as artifact visibility `public`.
