import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as CREATE } from "@/app/api/sites/route";
import { POST as EDIT } from "@/app/api/sites/[slug]/edit/route";
import { POST as VERSION } from "@/app/api/sites/[slug]/versions/route";
import { createSite } from "@/lib/sites";

afterEach(() => vi.unstubAllEnvs());

/** Produce chunks on demand, including a source that must be cancelled before EOF. */
function streamed(url: string, body: Uint8Array, contentType: string, declared?: string, token?: string) {
  let offset = 0;
  const cancel = vi.fn();
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === body.length) { controller.close(); return; }
      const end = Math.min(offset + 64, body.length);
      controller.enqueue(body.slice(offset, end));
      offset = end;
    },
    cancel,
  });
  const headers: Record<string, string> = { "content-type": contentType };
  if (declared !== undefined) headers["content-length"] = declared;
  if (token) headers["x-edit-token"] = token;
  return { request: new Request(url, { method: "POST", headers, body: source, duplex: "half" } as RequestInit & { duplex: "half" }), cancel, consumed: () => offset };
}
const bytes = (body: object) => new TextEncoder().encode(JSON.stringify(body));

describe("inline bodies are bounded by bytes read, not a client-supplied length", () => {
  it.each([undefined, "1"])("rejects and cancels oversized JSON (declared length %s)", async (declared) => {
    vi.stubEnv("ARTIFACT_INLINE_UPLOAD_MAX_BYTES", "128");
    const data = bytes({ mode: "paste", html: `<h1>${"x".repeat(4096)}</h1>` });
    const input = streamed("http://localhost/api/sites", data, "application/json", declared);
    const response = await CREATE(input.request);
    expect(response.status).toBe(413);
    expect(input.cancel).toHaveBeenCalled();
    expect(input.consumed()).toBeLessThan(data.length);
  });

  it("uses the same actionable error for declared and streamed overflow", async () => {
    vi.stubEnv("ARTIFACT_INLINE_UPLOAD_MAX_BYTES", "128");
    const data = bytes({ mode: "paste", html: "x".repeat(4096) });
    const declared = streamed("http://localhost/api/sites", data, "application/json", String(data.length));
    const chunked = streamed("http://localhost/api/sites", data, "application/json");
    const first = await CREATE(declared.request);
    const second = await CREATE(chunked.request);
    expect(first.status).toBe(413);
    expect(second.status).toBe(413);
    const body = await first.json();
    expect(await second.json()).toEqual(body);
    expect(body.error).toContain("0.0001220703125 MiB (128 bytes)");
    expect(body.error).toContain("source edits must fit within this limit");
  });

  it("rejects and cancels oversized multipart before parsing files", async () => {
    const form = new FormData();
    form.set("mode", "file");
    form.set("file", new File(["x".repeat(4096)], "index.html"));
    const encoded = new Response(form);
    const data = new Uint8Array(await encoded.arrayBuffer());
    vi.stubEnv("ARTIFACT_INLINE_UPLOAD_MAX_BYTES", "256");
    const input = streamed("http://localhost/api/sites", data, encoded.headers.get("content-type")!);
    expect((await CREATE(input.request)).status).toBe(413);
    expect(input.cancel).toHaveBeenCalled();
    expect(input.consumed()).toBeLessThan(data.length);
  });

  it("accepts a JSON body exactly at the byte limit, including multibyte text", async () => {
    const data = bytes({ mode: "paste", html: "<h1>你好</h1>" });
    vi.stubEnv("ARTIFACT_INLINE_UPLOAD_MAX_BYTES", String(data.length));
    const input = streamed("http://localhost/api/sites", data, "application/json");
    expect((await CREATE(input.request)).status).toBe(200);
    expect(input.cancel).not.toHaveBeenCalled();
  });

  it.each(["edit", "versions"] as const)("also bounds authenticated %s requests", async (route) => {
    const { site } = await createSite({ mode: "paste", html: "<h1>Original</h1>" });
    vi.stubEnv("ARTIFACT_INLINE_UPLOAD_MAX_BYTES", "128");
    const html = `<h1>${"x".repeat(4096)}</h1>`;
    const input = streamed(`http://localhost/api/sites/${site.slug}/${route}`,
      bytes(route === "edit" ? { content: html } : { mode: "paste", html }), "application/json", undefined, site.editToken);
    const response = await (route === "edit" ? EDIT : VERSION)(input.request, { params: Promise.resolve({ slug: site.slug }) });
    expect(response.status).toBe(413);
    expect(input.cancel).toHaveBeenCalled();
  });
});
