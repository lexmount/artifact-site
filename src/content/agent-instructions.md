# Using artifact-site

Instructions for agents using this artifact-site deployment.

Base URL: {{BASE_URL}}
MCP endpoint: {{BASE_URL}}/mcp

Read the [complete agent guide]({{BASE_URL}}/for-agents.md) before
performing operations. It documents authentication, API contracts,
upload limits, runtime restrictions, and recovery procedures.

## Identify the work

- Use the artifact the user identified.
- When updating existing work, preserve its identity and main URL.
- Ask for clarification only when the intended artifact or action is unclear.
- Respond in the user's language.

## Connect

- Reuse a valid connection to this deployment when available.
- Browser sign-in does not automatically authenticate a CLI or MCP client.
- Follow the documented authorization flow when a connection is needed.
- Never ask the user to paste credentials into chat.

## Publish and update

- Upload ready-to-serve HTML or build output. The service does not run
  application builds or backend code.
- Check this deployment's upload limits before preparing large uploads.
- Keep artifact resources compatible with the documented sandbox and
  path rules.
- Update an existing artifact instead of creating a duplicate.
- After an interrupted request, use the documented recovery procedure
  before retrying a write.

## Manage access

- Creating an artifact or returning its URL does not authorize broader access.
- Use private access unless the user requests another audience, and
  inspect the actual returned access settings.
- Ordinary link sharing uses the existing main URL with unlisted access.
- Public visibility also enables public discovery; use it only when requested.
- Main-link settings, member permissions, and independent sharing links
  are separate. Making the main link private does not revoke the others.
- Create independent sharing links only when the user requests them.

## Report the result

- Return the canonical artifact URL and its actual access state.
- Distinguish saved content, active sharing, and changes awaiting review.
- If publishing succeeds but a later step fails, report the saved artifact
  and retry only the incomplete step.
- Follow the guide's version check so instructions match this deployment.

[Full reference]({{BASE_URL}}/for-agents.md)
