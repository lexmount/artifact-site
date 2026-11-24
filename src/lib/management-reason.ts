import { z } from "zod";

export function normalizeReasonText(value: string): string {
  return value.replace(/\r\n?|\n/g, " ").trim();
}

/** Body and header transports share the same normalization, length and database constraints. */
const normalizedReasonSchema = z.string({ error: "A reason is required" }).transform(normalizeReasonText).pipe(
  z.string().max(500, "The reason is too long (500 characters at most)")
    .refine(value => !value.includes("\0"), "A reason cannot contain NUL characters"),
);
export const managementReasonSchema = normalizedReasonSchema.refine(value => value.length > 0, "A reason is required");
export const optionalManagementReasonSchema = normalizedReasonSchema.transform(value => value || undefined).optional();

/** ASCII-safe transport for administrative reasons, including legacy clients. */
export function managementReasonHeaders(reason: string): Record<string, string> {
  return {
    "x-management-reason": encodeURIComponent(normalizeReasonText(reason)),
    "x-management-reason-encoding": "percent",
  };
}

export function managementReason(request: Request): string | null {
  let value = request.headers.get("x-management-reason");
  if (value === null) return null;
  const encoding = request.headers.get("x-management-reason-encoding");
  if (encoding) {
    if (encoding !== "percent") return null;
    try { value = decodeURIComponent(value); } catch { return null; }
  }
  const parsed = managementReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
