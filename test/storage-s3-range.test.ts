// S3Storage.readRange against a mocked client: the zero-byte normalisation, and nothing else being
// swallowed. The live round-trip (storage-s3.integration.test.ts) needs credentials; this does not.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { S3Storage } from "@/lib/storage-s3";

const ENV = { ARTIFACT_S3_ENDPOINT: "https://s3.example.test", ARTIFACT_S3_BUCKET: "b", ARTIFACT_S3_ACCESS_KEY_ID: "k", ARTIFACT_S3_SECRET_ACCESS_KEY: "s", ARTIFACT_S3_REGION: "auto" };
beforeEach(() => { for (const [k, v] of Object.entries(ENV)) process.env[k] = v; });
afterEach(() => { for (const k of Object.keys(ENV)) delete process.env[k]; });

function withClient(send: (cmd: { input: Record<string, unknown> }) => Promise<unknown>): S3Storage {
  const storage = new S3Storage();
  (storage as unknown as { client: { send: typeof send } }).client = { send };
  return storage;
}

describe("S3Storage.readRange", () => {
  it("a zero-byte object (416 InvalidRange from byte 0) reads as an empty slice, like the local backend", async () => {
    const storage = withClient(async () => { throw Object.assign(new Error("Range Not Satisfiable"), { name: "InvalidRange", $metadata: { httpStatusCode: 416 } }); });
    expect(await storage.readRange("s", "v", "empty.txt", 0, 1023)).toEqual({ bytes: new Uint8Array(0), total: 0 });
  });

  it("a range starting past the end of a non-empty object is still an error, and other failures pass through", async () => {
    const storage = withClient(async () => { throw Object.assign(new Error("Range Not Satisfiable"), { name: "InvalidRange", $metadata: { httpStatusCode: 416 } }); });
    await expect(storage.readRange("s", "v", "one.txt", 5, 9)).rejects.toThrow(/Range/);
    const denied = withClient(async () => { throw Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }); });
    await expect(denied.readRange("s", "v", "x.txt", 0, 9)).rejects.toThrow(/Access Denied/);
  });

  it("a satisfiable range returns the bytes and the total from Content-Range", async () => {
    const storage = withClient(async () => ({ Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) }, ContentRange: "bytes 0-2/12345" }));
    const slice = await storage.readRange("s", "v", "x.txt", 0, 2);
    expect(Array.from(slice.bytes)).toEqual([1, 2, 3]);
    expect(slice.total).toBe(12345);
  });
});

it("writes normalized PNG and JPEG attachment MIME metadata",async()=>{
  for(const mime of ["image/png","image/jpeg"] as const) {
    let input: Record<string,unknown> | undefined;
    const storage=withClient(async command=>{input=command.input;return {};});
    const bytes=new Uint8Array([1,2,3]);
    await storage.writeCommentAttachment("cat_image",bytes,mime);
    expect(input).toMatchObject({Key:"comment-attachments/cat_image",ContentType:mime,Body:bytes});
  }
});
