// The error a lib function throws when the CALLER's input is at fault — an empty upload, a path
// that escapes the tree, a title that is too long. It carries `statusCode = 400` so the API layer
// (app/api/_util.errorResponse) answers 400 with the message intact, exactly as it always has for
// these; a plain `Error` is now treated as an internal fault and answered with a generic 500,
// because a message nobody wrote for a client is a stack frame away from being a leak.
//
// The rule for choosing: if the text was written to be read by the person who sent the request,
// it is a BadRequestError. If it describes a state the server got itself into, it stays an Error.

export class BadRequestError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

/**
 * A per-owner cap was hit (sites or bytes). 403 with a machine-readable `code` and the numbers:
 * an agent can tell "delete something" from "you are not allowed", and a person sees how far over.
 */
export class QuotaExceededError extends Error {
  readonly statusCode = 403;
  readonly code = "quota_exceeded";
  readonly details: { kind: "sites" | "bytes"; limit: number; used: number; requested: number };
  constructor(message: string, details: QuotaExceededError["details"]) {
    super(message);
    this.name = "QuotaExceededError";
    this.details = details;
  }
}

/** Transient receipt contention: retry the same file upload in the existing session. */
export class UploadConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "upload_conflict";
  readonly retryable = true;
  constructor() {
    super("Concurrent upload; retry the same file upload after a short delay");
    this.name = "UploadConflictError";
  }
}
