// Shared route helpers — response shaping, error mapping, and request-body parsing for the
// /api/sites endpoints. Not a route (no `route.ts`), so Next never treats it as an endpoint.
import { NextResponse } from "next/server";
import { z } from "zod";
import { limits } from "@/lib/config";
import { BadRequestError, QuotaExceededError } from "@/lib/errors";
import { TokenRejectedError } from "@/lib/auth";
import { getSkillVersion, LEGACY_SKILL_VERSION_HEADER, SKILL_VERSION_HEADER } from "@/lib/publish-skill";
import type { UploadFile, UploadInput } from "@/lib/types";

/** JSON response with a status code. Every answer carries the version of the agent guide this
 *  deployment serves, so an agent working from an installed copy can tell it has gone stale
 *  (the guide says what to do: refetch /for-agents.md). One header, no extra round-trip. */
export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { [SKILL_VERSION_HEADER]: getSkillVersion(), [LEGACY_SKILL_VERSION_HEADER]: getSkillVersion() } });
}

/** Request body exceeded the declared-size ceiling (413). */
export class PayloadTooLargeError extends Error {
  readonly statusCode = 413;
  constructor(message = "The upload is too large") {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

/**
 * Uniform error → HTTP mapping. ZodError → 400 with issues; a JSON SyntaxError (a body that does
 * not parse) → 400; any error carrying a numeric `statusCode` (BadRequestError 400, AuthError 401,
 * EditForbiddenError 403, PayloadTooLargeError 413, RateLimitError 429, …) maps to it with its
 * message intact. Everything else is an INTERNAL fault: logged server-side and answered with a
 * generic 500. A message nobody wrote for a client (a driver's, a library's, a stack frame's) is
 * not echoed — see lib/errors for the rule that decides which errors are meant to be read.
 */
export function errorResponse(error: unknown): NextResponse {
  if (error instanceof z.ZodError) return json({ error: "invalid request body", issues: error.issues }, 400);
  if (error && typeof error === "object" && "statusCode" in error) {
    const status = (error as { statusCode: unknown }).statusCode;
    if (typeof status === "number") {
      // `code` / `details` ride along for the one error written to carry them. Deliberately not a
      // generic "any field named details": a future error class must opt in here, so nothing
      // internal reaches a client by accident.
      const extra = error instanceof QuotaExceededError ? { code: error.code, details: error.details }
        : error instanceof TokenRejectedError ? { code: error.code }
        : {};
      return json({ error: error instanceof Error ? error.message : String(error), ...extra }, status);
    }
  }
  // `request.json()` on a malformed body throws a bare SyntaxError — the caller's fault, and the
  // parser's message ("Unexpected token …") is safe and useful.
  if (error instanceof SyntaxError) return json({ error: `invalid request body: ${error.message}` }, 400);
  console.error("[api] internal error:", error);
  return json({ error: "internal error" }, 500);
}

/**
 * `?expected_version=` — the optimistic-lock base, shared by the two write paths that accept one
 * (`POST /edit` and `POST /versions`). Both must read it identically: a guard that silently means
 * different things on two routes is worse than no guard, since the caller cannot tell which it got.
 *
 * A bare number is the one mistake the assistant contract invites (`artifactHub.version` is a
 * human-facing ordinal; the lock wants `versionId`). It can never match a `ver_…` id, so left
 * alone it would surface as an endless, unexplainable 409 — answer with directions instead.
 */
export function parseExpectedVersion(request: Request): { value?: string; rejection?: NextResponse } {
  const raw = new URL(request.url).searchParams.get("expected_version")?.trim();
  if (!raw) return {};
  // Anything that is not shaped like a version id can never match one, so forwarding it would
  // turn every attempt into a 409 the caller cannot escape: it re-exports, retries with the same
  // malformed value, and conflicts again forever. A bare number is the common case (the ordinal
  // instead of the id), but `abc` / `ver` / `ver_` fail identically — this is a bad REQUEST, and
  // saying so once is what lets the caller fix it.
  if (!raw.startsWith("ver_") || raw.length <= "ver_".length) {
    return {
      rejection: json({
        error: "expected_version must be a version id (the string starting with ver_), not a version number or anything else. Use the x-artifact-version header from the export response, or artifactHub.versionId from the context.",
        code: "expected_version_not_an_id",
      }, 400),
    };
  }
  return { value: raw };
}

/** The 409 both write paths answer when the site moved under a locked edit. */
export function versionConflictResponse(currentVersionId: string): NextResponse {
  return json({
    error: "Version conflict: the site was updated while you were editing. Export the current version again, apply your changes on top of it, and submit once more.",
    code: "version_conflict",
    currentVersionId,
  }, 409);
}

/**
 * Fast-reject an obviously-oversized upload by its declared Content-Length, before the body
 * is ever buffered into memory. readBodyWithinUploadLimit enforces the same ceiling on actual
 * bytes, including chunked requests and a false or missing Content-Length.
 */
export function assertContentLengthWithinLimit(request: Request): void {
  const raw = request.headers.get("content-length");
  if (!raw) return;
  const len = Number.parseInt(raw, 10);
  if (!Number.isFinite(len) || len < 0) return;
  // This guards the **one-shot upload** path, not the per-site size ceiling — the latter is now far
  // higher and is reached through the chunked channel. Rejecting early is the key: this path reads
  // the whole multipart body into memory, and once that blows up the process it is not just this one
  // request that fails but everyone at once with a 503 (observed in production).
  if (len > limits.inlineUploadMaxBytes) {
    throw inlineBodyTooLarge();
  }
}

function inlineBodyTooLarge(): PayloadTooLargeError {
  return new PayloadTooLargeError(
    `The request body exceeds the per-request limit ${limits.inlineUploadMaxBytes / 1048576} MiB (${limits.inlineUploadMaxBytes} bytes). Reduce the request size. `
    + `For large project uploads, use the chunked upload workflow documented in /for-agents.md; source edits must fit within this limit.`,
  );
}

/** Buffer at most the inline limit before JSON/multipart parsing allocates decoded objects. */
export async function readBodyWithinUploadLimit(request: Request, max = limits.inlineUploadMaxBytes): Promise<Response> {
  assertContentLengthWithinLimit(request);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { complete = true; break; }
        total += value.byteLength;
        if (total > max) throw max === limits.inlineUploadMaxBytes ? inlineBodyTooLarge() : new PayloadTooLargeError(`The request body exceeds ${max} bytes`);
        chunks.push(value);
      }
    } finally {
      // Do not await an untrusted source's cancellation: respond immediately on overflow/error.
      if (!complete) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  return new Response(Buffer.concat(chunks, total), { headers: { "content-type": request.headers.get("content-type") ?? "" } });
}

function enc(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

function b64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

// --- JSON upload wire format (Content-Type: application/json) -------------------
// Text-friendly; binary bytes come through base64 (zip) or are better sent multipart.
const jsonUploadSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("paste"), html: z.string(), title: z.string().optional() }),
  // `content` carries text (html); `base64` carries binary (pdf/office) — exactly one of the two.
  // Binary through `content` would be silently corrupted by the UTF-8 round-trip, so documents
  // MUST come base64 (or multipart, which is byte-clean by nature).
  z.object({ mode: z.literal("file"), filename: z.string(), content: z.string().optional(), base64: z.string().optional(), title: z.string().optional() })
    .refine((v) => (v.content === undefined) !== (v.base64 === undefined), { message: "file mode requires exactly one of content (text) or base64 (binary)" }),
  z.object({
    mode: z.literal("folder"),
    files: z.array(z.object({ path: z.string(), content: z.string() })).min(1),
    title: z.string().optional(),
  }),
  z.object({ mode: z.literal("zip"), base64: z.string(), title: z.string().optional() }),
]);

function fromJson(body: unknown): UploadInput {
  const parsed = jsonUploadSchema.parse(body);
  switch (parsed.mode) {
    case "paste":
      return { mode: "paste", html: parsed.html, title: parsed.title };
    case "file":
      return { mode: "file", filename: parsed.filename, bytes: parsed.content !== undefined ? enc(parsed.content) : b64(parsed.base64!), title: parsed.title };
    case "folder":
      return { mode: "folder", files: parsed.files.map((f) => ({ relpath: f.path, bytes: enc(f.content) })), title: parsed.title };
    case "zip":
      return { mode: "zip", bytes: b64(parsed.base64), title: parsed.title };
  }
}

// --- multipart upload wire format (Content-Type: multipart/form-data) -----------
// Fields:
//   mode   (required)  "paste" | "file" | "folder" | "zip"
//   title  (optional)  display title override
//   paste  → html      the HTML string
//   file   → file      one File; its name must end in .html
//   zip    → file      one File; the .zip archive bytes
//   folder → files     repeated File parts; the relpath is each File's name
//                      (client appends with the webkitRelativePath as the filename),
//                      or a positional `paths` field per file overrides it.
function formString(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === "string" ? value : undefined;
}

async function fromForm(form: FormData): Promise<UploadInput> {
  const mode = formString(form, "mode");
  const title = formString(form, "title") || undefined;
  switch (mode) {
    case "paste":
      return { mode: "paste", html: formString(form, "html") ?? "", title };
    case "file": {
      const file = form.get("file");
      if (!(file instanceof File)) throw new BadRequestError("file mode requires a `file` field");
      return { mode: "file", filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()), title };
    }
    case "zip": {
      const file = form.get("file");
      if (!(file instanceof File)) throw new BadRequestError("zip mode requires a `file` field");
      return { mode: "zip", bytes: new Uint8Array(await file.arrayBuffer()), title };
    }
    case "folder": {
      const files = form.getAll("files").filter((v): v is File => v instanceof File);
      if (files.length === 0) throw new BadRequestError("folder mode requires one or more `files` fields");
      const paths = form.getAll("paths").filter((v): v is string => typeof v === "string");
      const usePaths = paths.length === files.length;
      const out: UploadFile[] = [];
      for (let i = 0; i < files.length; i++) {
        out.push({ relpath: usePaths ? paths[i] : files[i].name, bytes: new Uint8Array(await files[i].arrayBuffer()) });
      }
      return { mode: "folder", files: out, title };
    }
    default:
      throw new BadRequestError(`Unknown or missing mode: ${mode ?? "(none)"}`);
  }
}

/** Parse POST /api/sites body (json or multipart) into an UploadInput for createSite. */
export async function parseUploadInput(request: Request): Promise<UploadInput> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return fromJson(await (await readBodyWithinUploadLimit(request)).json());
  if (contentType.includes("multipart/form-data")) return fromForm(await (await readBodyWithinUploadLimit(request)).formData());
  throw new BadRequestError("Unsupported Content-Type: application/json or multipart/form-data is required");
}
