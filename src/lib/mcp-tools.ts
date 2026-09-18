// Public tool labels, checked against server registrations by tests.
export const mcpTools = [
  ["artifact_site_connection", "Connection information"],
  ["artifact_site_publish", "Publish a site"],
  ["artifact_site_update", "Update a site"],
  ["artifact_site_edit", "Edit a file"],
  ["artifact_site_find", "Find artifacts"],
  ["artifact_site_get_site", "Get a site"],
  ["artifact_site_read", "Read a site"],
  ["artifact_site_fork", "Fork a site"],
  ["artifact_site_share", "Create a share link"],
  ["artifact_site_set_official", "Set official version"],
  ["artifact_site_clear_official", "Clear official version"],
  ["artifact_site_rollback", "Roll back a site"],
  ["artifact_site_delete", "Delete a site"],
  ["artifact_site_export", "Export a site"],
  ["artifact_site_operation_status", "Publication status"],
  ["artifact_site_upload_status", "Upload progress"],
  ["artifact_site_upload_start", "Start an upload"],
  ["artifact_site_upload_write", "Write upload content"],
  ["artifact_site_upload_cancel", "Cancel an upload"],
] as const;

/** The tools that only read. One list for two consumers: the `readOnlyHint` annotation the MCP
 *  server publishes, and the OAuth scope gate (lib/oauth-shared) — a read-only grant may call
 *  exactly these. Keeping them apart is how the two would drift. */
export const readOnlyMcpTools: ReadonlySet<string> = new Set([
  "artifact_site_operation_status", "artifact_site_upload_status", "artifact_site_connection", "artifact_site_find", "artifact_site_get_site", "artifact_site_read", "artifact_site_export",
]);
