// Office → PDF conversion for document sites, behind a small Converter seam (same shape of
// pluggability as lib/storage): today the backend is Gotenberg — a stateless intranet container
// we PUSH bytes to over multipart, so no public surface, no credential channel, no callback —
// and if its fidelity ever falls short, the seam is where an OnlyOffice ConvertService lands.
//
// Conversion is SYNCHRONOUS inside the create request, on purpose: the version is written once,
// complete and immutable (preview included or definitively absent), so there is no pending state,
// no polling, no repair job. "Publishing never fails because of a preview" is the contract; every way a preview can go
// wrong — converter off, unreachable, slow, queue full, output too big — degrades to the download
// card with the reason, and NEVER to a failed publish.
import { config, limits } from "@/lib/config";
import { buildDocumentFiles, needsConversion } from "@/lib/document-site";
import type { NormalizedUpload } from "@/lib/types";

export class ConversionError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ConversionError";
  }
}

/** The seam. `toPdf` resolves with the converted bytes or throws ConversionError. `signal`, when
 *  given, carries the caller's remaining time budget — implementations should abort on it. */
export interface Converter {
  toPdf(filename: string, bytes: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>;
}

/** Gotenberg's LibreOffice route: multipart in, PDF bytes out. */
export class GotenbergConverter implements Converter {
  constructor(private readonly baseUrl: string, private readonly timeoutMs: number) {}

  async toPdf(filename: string, bytes: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    const form = new FormData();
    // The filename matters: Gotenberg picks the LibreOffice import filter from its extension.
    form.append("files", new File([new Uint8Array(bytes)], filename));
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/forms/libreoffice/convert`, {
        method: "POST",
        body: form,
        signal: signal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new ConversionError(timedOut ? "Conversion timed out" : "Conversion service unreachable", error);
    }
    if (!response.ok) {
      // The body goes to the SERVER LOG only. Gotenberg's own errors are terse, but a mispointed
      // GOTENBERG_URL or an interposed proxy answers with arbitrary third-party content, and this
      // string ends up on a publicly shareable card — the status code is all a visitor gets.
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      console.error(`[convert] backend HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      throw new ConversionError(`Conversion failed (HTTP ${response.status})`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

/** Process-wide conversion slots. Strict FIFO via slot HANDOFF — see acquireSlot/releaseSlot. */
interface SlotWaiter { grant: () => void; dead: boolean }
const slots: { active: number; queue: SlotWaiter[] } = { active: 0, queue: [] };

/**
 * Take a conversion slot, or throw ConversionError when the deadline passes first.
 *
 * Fairness by HANDOFF, not decrement-and-wake: releaseSlot passes slot ownership directly to the
 * next living waiter WITHOUT ever dropping `active`, so (a) a fresh caller can never see a
 * transiently-free slot and barge past the queue (the round-1 bug, measured peak 3 at cap 2),
 * and (b) a woken waiter never has to re-queue behind newcomers — the round-2 note: under
 * sustained pressure, re-queueing let early arrivals starve until their budget died.
 *
 * A timed-out waiter marks itself dead in place; releaseSlot skips corpses. `active < cap` can
 * only coexist with a queue of corpses (release only decrements when no living waiter exists),
 * so the fast path taking a slot then is correct, not barging.
 */
async function acquireSlot(deadline: number): Promise<void> {
  if (slots.active < config.convertConcurrency) {
    slots.active++;
    return;
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ConversionError("Timed out waiting in the conversion queue");
  // Hard cap as a backstop: a flood beyond any plausible wait is refused instantly — the card
  // IS the designed answer to "can't convert right now"; parking uploads helps nobody.
  if (slots.queue.length >= config.convertConcurrency * 10) throw new ConversionError("The conversion queue is full");
  const granted = await new Promise<boolean>((resolve) => {
    const waiter: SlotWaiter = { dead: false, grant: () => { clearTimeout(timer); resolve(true); } };
    const timer = setTimeout(() => {
      // Leave NO corpse behind: the queue-full backstop measures queue.length, and dead entries
      // counting toward it misclassify the next upload as "queue full" (pointing operators at "burst
      // too big" when the truth is "budget/concurrency too small" — the exact wrong row of the
      // DEPLOY.md triage table). grant()'s clearTimeout already excludes the reverse race, and
      // the dead flag stays as a belt for any path that still finds this entry queued.
      waiter.dead = true;
      const index = slots.queue.indexOf(waiter);
      if (index >= 0) slots.queue.splice(index, 1);
      resolve(false);
    }, remaining);
    slots.queue.push(waiter);
  });
  if (!granted) throw new ConversionError("Timed out waiting in the conversion queue");
  // Ownership was transferred by releaseSlot — `active` already accounts for this slot.
}

function releaseSlot(): void {
  for (let next = slots.queue.shift(); next; next = slots.queue.shift()) {
    if (!next.dead) { next.grant(); return; } // hand the slot over; active stays as-is
  }
  slots.active--; // nobody alive to inherit it
}

/** The configured converter, or null when conversion is off (no GOTENBERG_URL). */
function getConverter(): Converter | null {
  const base = config.gotenbergUrl;
  return base ? new GotenbergConverter(base, config.convertTimeoutMs) : null;
}

/**
 * Upgrade a normalized document upload with a PDF preview, when possible. Non-document uploads
 * and pdf documents pass through untouched. Office documents:
 *
 *   converter configured + conversion ok      → viewer wrapper + preview.pdf
 *   converter off                             → download card (dev / conversion-less deploys)
 *   failed / timed out / queue full           → download card carrying the reason
 *   converted fine but the result blows the   → download card: the user's own file is legal, and
 *   per-file or per-site size limit             OUR generated preview must never fail THEIR publish
 *
 * ARTIFACT_CONVERT_TIMEOUT_MS is a TOTAL budget covering queue wait + conversion, so a burst of
 * uploads cannot hold a request past the gateway's patience — it degrades instead.
 */
export async function applyDocumentConversion(
  normalized: NormalizedUpload,
  converter: Converter | null = getConverter(),
): Promise<NormalizedUpload> {
  const meta = normalized.document;
  if (!meta || !needsConversion(meta.format)) return normalized;
  const original = normalized.files.find((file) => file.relpath === meta.originalRelpath);
  if (!original) return normalized; // defensive: normalizeUpload always includes it
  if (!converter) return normalized; // conversion off → the card files normalizeUpload built

  const deadline = Date.now() + config.convertTimeoutMs;
  let pdf: Uint8Array;
  try {
    await acquireSlot(deadline);
    try {
      const remaining = deadline - Date.now();
      // Observability for "why are cards spiking": a conversion that fails NOW with a tiny
      // remaining budget looks identical in the wild to one that genuinely ran long. Log where
      // the time went, and don't start a conversion queueing left without a realistic budget
      // (floor scales down with tiny configured budgets so short-budget setups keep working).
      // Distinct wording on purpose: "budget used up" = got a slot but earlier conversions ate the
      // budget (single conversions too slow for the queue depth); "queue timeout" = never got a slot
      // (queue too deep for CONCURRENCY). Different knobs — the card must say which.
      if (remaining < Math.min(2000, config.convertTimeoutMs / 4)) throw new ConversionError("Waiting in the conversion queue used up the time budget");
      if (remaining < config.convertTimeoutMs / 2) {
        console.warn(`[convert] ${meta.originalName}: queueing consumed ${config.convertTimeoutMs - remaining}ms of the ${config.convertTimeoutMs}ms budget`);
      }
      pdf = await converter.toPdf(meta.originalName, original.bytes, AbortSignal.timeout(remaining));
    } finally {
      releaseSlot();
    }
  } catch (error) {
    const reason = error instanceof ConversionError ? error.message : "Conversion failed";
    console.error(`[convert] ${meta.originalName}: ${reason}`, error instanceof ConversionError ? error.cause ?? "" : error);
    return { ...normalized, files: buildDocumentFiles(meta, original.bytes, null, `${reason} · Re-upload to retry, or download the original to view it`) };
  }

  // Success can still be unusable: a 25MB image-heavy deck often converts to a 26MB pdf, and
  // original+preview together would trip the site cap — an English storage-layer error on a file
  // the user legally uploaded. Drop the preview, keep the publish.
  const viewerFiles = buildDocumentFiles(meta, original.bytes, pdf);
  const totalBytes = viewerFiles.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (pdf.byteLength > limits.maxFileBytes || totalBytes > limits.maxBytes) {
    console.warn(`[convert] ${meta.originalName}: preview dropped — pdf ${pdf.byteLength}B, total ${totalBytes}B vs limits ${limits.maxFileBytes}/${limits.maxBytes}`);
    return { ...normalized, files: buildDocumentFiles(meta, original.bytes, null, `The converted preview is too large (about ${Math.ceil(pdf.byteLength / 1048576)}MB) and exceeds the site size limit, so only the original is available for download`) };
  }
  return { ...normalized, files: viewerFiles };
}
