import { gzipSync } from "node:zlib";

/** Small independent USTAR fixture writer; never extracts or touches uploaded paths. */
export function tarFixture(entries: { name: string; content?: string; type?: string; link?: string }[], gzip = false): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.content ?? "");
    const header = Buffer.alloc(512);
    const field = (offset: number, length: number, value: string) => header.write(value, offset, length, "utf8");
    field(0, 100, entry.name); field(100, 8, "0000644\0"); field(108, 8, "0000000\0"); field(116, 8, "0000000\0");
    field(124, 12, body.length.toString(8).padStart(11, "0") + "\0"); field(136, 12, "00000000000\0");
    header.fill(32, 148, 156); field(156, 1, entry.type ?? "0"); field(157, 100, entry.link ?? "");
    field(257, 6, "ustar\0"); field(263, 2, "00");
    field(148, 8, header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, "0") + "\0 ");
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  const bytes = Buffer.concat([...chunks, Buffer.alloc(1024)]);
  return gzip ? gzipSync(bytes) : bytes;
}
