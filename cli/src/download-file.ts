import { createWriteStream } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Replace the destination only after the entire decoded stream has arrived. */
export async function saveDownload(response: Response, file: string, expectedSize?: number, signal?: AbortSignal): Promise<number> {
  let temporary: string | undefined;
  try {
    signal?.throwIfAborted();
    temporary = await mkdtemp(join(dirname(resolve(file)), ".artifact-download-"));
    const partial = join(temporary, "partial");
    let bytes = 0;
    const counter = new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length;
      done(expectedSize !== undefined && bytes > expectedSize ? new Error("Download size mismatch") : null, chunk);
    } });
    const source = response.body ? Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>) : Readable.from([]);
    await pipeline(source, counter, createWriteStream(partial, { flags: "wx", mode: 0o600 }), { signal });
    if (expectedSize !== undefined && bytes !== expectedSize) throw new Error("Download size mismatch");
    signal?.throwIfAborted();
    await rename(partial, resolve(file));
    return bytes;
  } finally {
    await response.body?.cancel().catch(() => {});
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
