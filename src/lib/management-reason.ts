/** ASCII-safe transport for administrative reasons, with explicit encoding for legacy clients. */
export function managementReasonHeaders(reason: string): Record<string, string> {
  return {
    "x-management-reason": encodeURIComponent(reason.replace(/\r\n?|\n/g, " ").trim()),
    "x-management-reason-encoding": "percent",
  };
}

/** Validate the decoded value once for both authorization and audit consumers. */
export function managementReason(request: Request): string | null {
  let value = request.headers.get("x-management-reason");
  if (value === null) return null;
  const encoding = request.headers.get("x-management-reason-encoding");
  if (encoding) {
    if (encoding !== "percent") return null;
    try { value = decodeURIComponent(value); } catch { return null; }
  }
  value = value.replace(/\r\n?|\n/g, " ").trim();
  // PostgreSQL text cannot store NUL; reject it before granting management authority.
  return value && value.length <= 500 && !value.includes("\0") ? value : null;
}
