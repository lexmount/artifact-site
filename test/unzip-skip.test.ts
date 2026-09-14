import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { unzipBounded } from "@/lib/unzip";

/** Minimal writer for the subset of zip we parse: deflate entries, no zip64, no encryption. */
function makeZip(entries: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.from(text, "utf8");
    const comp = deflateRawSync(raw);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(8, 8); // deflate
    lfh.writeUInt32LE(comp.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lfh, nameBuf, comp);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(8, 10);
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

const names = (files: { name: string }[]) => files.map((f) => f.name).sort();

describe("unzipBounded — segment skipping and injectable caps", () => {
  it("extracts everything when no segments are skipped (unchanged default)", () => {
    const zip = makeZip({ "index.html": "<h1>hi</h1>", "app/main.js": "x" });
    expect(names(unzipBounded(zip))).toEqual(["app/main.js", "index.html"]);
  });

  // A source checkout that ships its dependencies must not be rejected outright — and today it
  // would be, since safeRelativePath THROWS on a node_modules segment rather than skipping it.
  it("drops skipped segments at any depth, case-insensitively, and through Windows separators", () => {
    const zip = makeZip({
      "package.json": "{}",
      "node_modules/left-pad/index.js": "x",
      "packages/ui/Node_Modules/dep/a.js": "x",
      "app\\Node_Modules\\dep\\b.js": "x",
      ".git/config": "x",
      "src/main.tsx": "x",
    });
    expect(names(unzipBounded(zip, { skipSegments: ["node_modules", ".git"] }))).toEqual(["package.json", "src/main.tsx"]);
  });

  // The skip has to happen BEFORE counting, or a tree with many dependency files still trips the
  // file cap even though none of those files would be kept.
  it("skips before the file cap is applied, not after", () => {
    const entries: Record<string, string> = { "package.json": "{}" };
    for (let i = 0; i < 50; i++) entries[`node_modules/p${i}/index.js`] = "x";
    const caps = { maxFiles: 5, maxBytes: 1 << 20, maxFileBytes: 1 << 20 };
    expect(() => unzipBounded(makeZip(entries), { caps })).toThrow(/Too many files/);
    expect(names(unzipBounded(makeZip(entries), { caps, skipSegments: ["node_modules"] }))).toEqual(["package.json"]);
  });

  it("honours injected caps so a source tree and a built artifact can have different budgets", () => {
    const zip = makeZip({ "a.txt": "0123456789", "b.txt": "0123456789" });
    expect(() => unzipBounded(zip, { caps: { maxFiles: 1, maxBytes: 1 << 20, maxFileBytes: 1 << 20 } })).toThrow(/Too many files/);
    expect(() => unzipBounded(zip, { caps: { maxFiles: 10, maxBytes: 15, maxFileBytes: 1 << 20 } })).toThrow(/too large after decompression/);
    expect(() => unzipBounded(zip, { caps: { maxFiles: 10, maxBytes: 1 << 20, maxFileBytes: 5 } })).toThrow(/possible zip bomb/);
  });
});
