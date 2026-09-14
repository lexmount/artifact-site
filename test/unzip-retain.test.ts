// A STORED (method 0) entry used to be returned as a subarray VIEW of the uploaded archive, so a
// 25-byte file kept the whole zip's ArrayBuffer alive. Nothing downstream can see that: the S3
// backend's read cache is LRU'd by `bytes.byteLength`, so it would charge 25 bytes for an entry
// pinning tens of megabytes. These tests assert each entry owns exactly its own memory.
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { unzipBounded } from "@/lib/unzip";

type Entry = { body: Uint8Array; stored: boolean };

const text = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));

/** Zip writer that can emit STORED as well as deflate entries (the existing helpers only do deflate). */
function makeZip(entries: Record<string, Entry>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, { body, stored }] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.from(body);
    const comp = stored ? raw : deflateRawSync(raw);
    const method = stored ? 0 : 8;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(comp.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lfh, nameBuf, comp);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(comp.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);
    centrals.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + comp.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return new Uint8Array(Buffer.concat([localBuf, centralBuf, eocd]));
}

/** True when `bytes` owns its ArrayBuffer outright — no window onto a larger buffer. */
function ownsItsMemory(bytes: Uint8Array): boolean {
  return bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.byteLength;
}

/**
 * The property that actually matters: the entry does not keep the uploaded archive alive.
 * Deliberately weaker than `ownsItsMemory`, because deflate output can't satisfy the strict form —
 * `zlib.inflateRawSync` returns a Buffer, and Node carves Buffers under 4KB out of a shared 8KB
 * pool, so a small inflated entry is legitimately a view into that pool. That pins at most one 8KB
 * pool chunk shared process-wide, which is nothing like pinning a 50MB upload per entry.
 */
function retainsArchive(bytes: Uint8Array, archive: Uint8Array): boolean {
  return bytes.buffer === archive.buffer;
}

/** Incompressible-ish filler, so the archive dwarfs the small entry under test either way. */
function filler(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 2654435761) % 251;
  return out;
}

const HTML = "<h1>hi</h1>";

describe("unzipBounded — extracted entries must not retain the whole archive", () => {
  it("gives a STORED entry its own buffer instead of a view over the upload", () => {
    const zip = makeZip({
      "index.html": { body: text(HTML), stored: true },
      "big.bin": { body: filler(256 * 1024), stored: true },
    });
    const entry = unzipBounded(zip).find((f) => f.name === "index.html")!;

    // The regression: a view would report the whole archive here (~256KB), not 11 bytes.
    expect(entry.bytes.byteLength).toBe(HTML.length);
    expect(entry.bytes.byteOffset).toBe(0);
    expect(entry.bytes.buffer.byteLength).toBe(entry.bytes.byteLength);
    expect(entry.bytes.buffer.byteLength).toBeLessThan(zip.byteLength);
    // Copying must not disturb the bytes themselves.
    expect(Buffer.from(entry.bytes).toString("utf8")).toBe(HTML);
  });

  it("copies STORED bytes exactly, including binary content at a non-zero archive offset", () => {
    const body = filler(4096);
    const zip = makeZip({
      "lead.bin": { body: filler(64 * 1024), stored: true }, // pushes the entry under test off offset 0
      "payload.bin": { body, stored: true },
    });
    const entry = unzipBounded(zip).find((f) => f.name === "payload.bin")!;

    expect(ownsItsMemory(entry.bytes)).toBe(true);
    expect(retainsArchive(entry.bytes, zip)).toBe(false);
    expect(Buffer.from(entry.bytes).equals(Buffer.from(body))).toBe(true);
  });

  it("no entry retains the archive, whatever the compression method", () => {
    const zip = makeZip({
      "a-stored.txt": { body: text("stored entry"), stored: true },
      "b-deflate.txt": { body: text("deflate entry"), stored: false },
      "c-empty.txt": { body: text(""), stored: true },
      "big.bin": { body: filler(128 * 1024), stored: false },
    });
    const files = unzipBounded(zip);

    expect(files.map((f) => f.name).sort()).toEqual(["a-stored.txt", "b-deflate.txt", "big.bin", "c-empty.txt"]);
    for (const file of files) {
      expect(retainsArchive(file.bytes, zip), `${file.name} still holds the archive's buffer`).toBe(false);
    }
    // STORED entries get the strict guarantee: their buffer is exactly their own bytes.
    for (const name of ["a-stored.txt", "c-empty.txt"]) {
      const file = files.find((f) => f.name === name)!;
      expect(ownsItsMemory(file.bytes), `${name} does not own its buffer`).toBe(true);
    }
  });

  it("deflate entries still decode correctly (no regression from the STORED change)", () => {
    const zip = makeZip({
      "index.html": { body: text(HTML), stored: false },
      "app/main.js": { body: text("console.log(1)"), stored: false },
    });
    const files = unzipBounded(zip);

    expect(files.map((f) => f.name).sort()).toEqual(["app/main.js", "index.html"]);
    expect(Buffer.from(files.find((f) => f.name === "index.html")!.bytes).toString("utf8")).toBe(HTML);
    expect(Buffer.from(files.find((f) => f.name === "app/main.js")!.bytes).toString("utf8")).toBe("console.log(1)");
  });

  it("keeps the STORED size caps exactly as they were (checked before any copy)", () => {
    const zip = makeZip({ "big.bin": { body: filler(4096), stored: true } });
    // Per-file cap: still rejected by the STORED branch, and never copied first.
    expect(() => unzipBounded(zip, { caps: { maxFiles: 10, maxBytes: 1 << 20, maxFileBytes: 4095 } })).toThrow(/is too large/);
    // Exactly at the cap is still allowed (boundary unchanged).
    expect(unzipBounded(zip, { caps: { maxFiles: 10, maxBytes: 1 << 20, maxFileBytes: 4096 } })).toHaveLength(1);
    // Total cap still trips on the summed output.
    expect(() => unzipBounded(zip, { caps: { maxFiles: 10, maxBytes: 4095, maxFileBytes: 1 << 20 } })).toThrow(/too large after decompression/);
  });
});
