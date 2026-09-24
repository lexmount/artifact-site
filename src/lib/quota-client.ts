export type QuotaDetails = {
  kind: "sites" | "bytes";
  limit: number;
  used: number;
  requested: number;
};

/** Treat API responses as untrusted input before using their numbers in the interface. */
export function quotaDetailsFrom(value: unknown): QuotaDetails | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const details = body.details;
  if (body.code !== "quota_exceeded" || !details || typeof details !== "object") return null;
  const d = details as Record<string, unknown>;
  if ((d.kind !== "sites" && d.kind !== "bytes") || ![d.limit, d.used, d.requested].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) return null;
  return { kind: d.kind, limit: d.limit as number, used: d.used as number, requested: d.requested as number };
}

export class ClientQuotaExceeded extends Error {
  constructor(readonly details: QuotaDetails) {
    super("quota exceeded");
    this.name = "ClientQuotaExceeded";
  }
}
