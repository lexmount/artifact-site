// Bounded zip extraction. Unlike a whole-archive decompressor, this enforces the per-file and
// total byte caps DURING inflation (via zlib's maxOutputLength, which aborts before the output
// materializes past the cap), so a forged/compressed zip bomb is rejected without a memory spike.
// Reads the central directory (authoritative sizes/offsets — sidesteps data-descriptor ambiguity),
// then slices each entry's compressed bytes via its local header and inflates with a hard cap.
import zlib from "node:zlib";
import { limits } from "@/lib/config";
import { BadRequestError } from "@/lib/errors";

export interface UnzippedFile { name: string; bytes: Uint8Array }

const EOCD_SIG = 0x06054b50; // end of central directory
const CDH_SIG = 0x02014b50; // central directory file header
const LFH_SIG = 0x04034b50; // local file header

// Filenames are decoded as UTF-8 (matches the prior fflate behavior). A legacy CP437 archive with
// non-ASCII names would mojibake, but names still pass through safeRelativePath, so there's no safety
// impact — only cosmetic. ASCII (the overwhelming common case) is unaffected.
function utf8(data: Uint8Array, offset: number, length: number): string {
  return Buffer.from(data.subarray(offset, offset + length)).toString("utf8");
}

function findEocd(data: Uint8Array, view: DataView): { entryCount: number; cdOffset: number; cdSize: number } {
  // The EOCD is at the end, before an optional comment (≤ 65535 bytes). Scan backwards for the
  // signature AND require its comment-length field to match the actual trailing bytes — otherwise a
  // signature that happens to appear inside a comment/trailer would be mistaken for the real EOCD.
  const min = Math.max(0, data.byteLength - 22 - 0xffff);
  for (let i = data.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIG && view.getUint16(i + 20, true) === data.byteLength - (i + 22)) {
      return {
        entryCount: view.getUint16(i + 10, true),
        cdSize: view.getUint32(i + 12, true),
        cdOffset: view.getUint32(i + 16, true),
      };
    }
  }
  throw new BadRequestError("Not a valid zip archive (central directory not found)");
}

/** Extraction caps. Defaults to the per-version `limits`; a source checkout passes its own. */
export interface UnzipCaps {
  maxFiles: number;
  maxBytes: number;
  maxFileBytes: number;
}

export interface UnzipOptions {
  caps?: UnzipCaps;
  /**
   * Path segments to drop entirely, matched case-insensitively against each segment (e.g.
   * `node_modules`, `.git`). Dropping happens BEFORE the entry is counted or inflated, which is
   * the whole point: a source checkout that ships its dependencies would otherwise blow the file
   * cap — and be rejected outright, since safeRelativePath treats those segments as unsafe rather
   * than skippable. Never widen this to build-output names like `dist`; a finished site legitimately
   * has a directory called that.
   */
  skipSegments?: readonly string[];
  /** Keep only entries this accepts — checked before the entry is counted or inflated, so the
   *  rest of the archive costs nothing (an office file's text parts, not its media). */
  only?: (name: string) => boolean;
}

export function unzipBounded(data: Uint8Array, options: UnzipOptions = {}): UnzippedFile[] {
  const caps = options.caps ?? limits;
  const skip = new Set((options.skipSegments ?? []).map((s) => s.toLowerCase()));
  if (data.byteLength < 22) throw new BadRequestError("Not a valid zip archive");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const { entryCount, cdOffset, cdSize } = findEocd(data, view);
  // Our size limits mean a legitimate archive is never zip64; refuse rather than parse the 64-bit format.
  if (entryCount === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new BadRequestError("zip64 archives are not supported");
  }

  const files: UnzippedFile[] = [];
  let total = 0;
  let count = 0;
  let p = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > data.byteLength || view.getUint32(p, true) !== CDH_SIG) throw new BadRequestError("The archive's central directory is corrupt");
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const fnLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = utf8(data, p + 46, fnLen);
    p += 46 + fnLen + extraLen + commentLen;

    if (name.endsWith("/")) continue; // directory entry — no data
    if (flags & 0x1) throw new BadRequestError(`Encrypted archive entries are not supported: ${name}`);
    // Same segment normalization as safeRelativePath, so "Node_Modules" and backslash-separated
    // paths from Windows zips are dropped too rather than sneaking past into the count.
    if (skip.size && name.normalize("NFC").replaceAll("\\", "/").split("/").some((seg) => skip.has(seg.toLowerCase()))) continue;
    if (options.only && !options.only(name)) continue;

    count += 1;
    if (count > caps.maxFiles) throw new BadRequestError(`Too many files in the archive: over the limit of ${caps.maxFiles}`);

    // The local header's filename/extra lengths can differ from the central directory's, so read
    // them to locate where this entry's compressed data actually begins.
    if (localOffset + 30 > data.byteLength || view.getUint32(localOffset, true) !== LFH_SIG) throw new BadRequestError("The archive's local file header is corrupt");
    const lfnLen = view.getUint16(localOffset + 26, true);
    const lextraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lfnLen + lextraLen;
    if (dataStart + compSize > data.byteLength) throw new BadRequestError("Archive entry data runs past the end of the file");
    const comp = data.subarray(dataStart, dataStart + compSize);

    let out: Uint8Array;
    if (method === 0) {
      // STORED: the "compressed" bytes are the file. Its size is known up front.
      if (comp.byteLength > caps.maxFileBytes) {
        throw new BadRequestError(`A file in the archive is too large: ${name} (${Math.round(comp.byteLength / 1048576)}MB; the per-file limit is ${Math.round(caps.maxFileBytes / 1048576)}MB)`);
      }
      // Copy, never hand back the subarray view: a view keeps the WHOLE uploaded zip's ArrayBuffer
      // (up to maxBytes) alive for as long as the entry is referenced, so a 25-byte STORED file can
      // pin 50MB. That retention is invisible to any byteLength-based accounting downstream — the S3
      // backend's in-process read cache is LRU'd by total bytes and would charge such an entry 25
      // bytes while it actually holds the whole archive, blowing its budget by orders of magnitude.
      // Cost of copying: extraction now peaks at the zip plus the extracted bytes instead of the zip
      // alone. Both sides are already capped (maxFileBytes 32MB per file, maxBytes 50MB per version),
      // so the extra is bounded and short-lived — the zip buffer is dropped once extraction returns —
      // whereas the retention it replaces is unbounded in duration. The deflate branch below already
      // allocates a fresh buffer per entry, so this only makes STORED match the common path.
      // `new Uint8Array(view)` (not `.slice()`) is deliberate: if `data` is a Buffer, `comp` is too,
      // and Buffer.prototype.slice is the deprecated view-returning alias — it would silently copy
      // nothing. The TypedArray constructor always copies into a fresh, exactly-sized ArrayBuffer.
      out = new Uint8Array(comp);
    } else if (method === 8) {
      if (comp.byteLength === 0) {
        out = new Uint8Array(0); // some tools emit a zero-length deflate stream for an empty file
      } else {
        try {
          // maxOutputLength throws only when output STRICTLY exceeds it, so pass maxFileBytes to
          // allow exactly the cap and reject one byte over — matching the STORED branch's boundary.
          out = zlib.inflateRawSync(comp, { maxOutputLength: caps.maxFileBytes });
        } catch (error) {
          if (error && typeof error === "object" && (error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
            throw new BadRequestError(`A file in the archive is too large after decompression: ${name} (over the per-file limit of ${Math.round(caps.maxFileBytes / 1048576)}MB; possible zip bomb)`);
          }
          throw new BadRequestError(`Failed to decompress archive entry: ${name}`);
        }
      }
    } else {
      throw new BadRequestError(`Unsupported compression method (${method}): ${name}`);
    }

    total += out.byteLength;
    if (total > caps.maxBytes) {
      throw new BadRequestError(`The archive is too large after decompression: over the per-site limit of ${Math.round(caps.maxBytes / 1048576)}MB (possible zip bomb)`);
    }
    files.push({ name, bytes: out });
  }
  return files;
}
