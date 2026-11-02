import { traceUpload, timeUpload, uploadBytes } from "@/lib/upload-timing";
import { ARCHIVE_CHUNK_BYTES, writeBinaryChunk } from "@/lib/mcp/files";
import { getUploadSession, ownerKeyFor } from "@/lib/upload-session";
import { CROSS_SITE_REJECTED, isCrossSiteForTarget } from "@/lib/upload-csrf";
import { checkUploadRateLimit } from "@/lib/ratelimit";
import { BadRequestError } from "@/lib/errors";
import { errorResponse, json } from "@/lib/api-http";

/** Binary archive chunks. MCP uses the same durable receipts with its smaller message ceiling. */
export async function PUT(request: Request, context: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await context.params;
  return traceUpload(request, versionId, async () => {
    try {
      checkUploadRateLimit(request);
      const session = await timeUpload("auth", async () => getUploadSession(versionId, await ownerKeyFor(request)));
      if (!session) return json({ error: "Upload session not found or expired", code: "upload_not_found" }, 404);
      if (await isCrossSiteForTarget(request, session)) return json({ error: CROSS_SITE_REJECTED }, 401);
      if (session.packageOptions?.source !== "archive") throw new BadRequestError("Chunk uploads require an archive package");
      const url = new URL(request.url), raw = url.searchParams.get("index");
      if (raw === null || !/^\d+$/.test(raw) || !["0", "1"].includes(url.searchParams.get("final") ?? "")) throw new BadRequestError("Invalid chunk index or final flag");
      if (Number(request.headers.get("content-length")) > ARCHIVE_CHUNK_BYTES) return json({ error: "Upload chunk exceeds 4 MiB" }, 413);
      const reader = request.body?.getReader();
      if (!reader) throw new BadRequestError("The request has no body");
      const chunks: Uint8Array[] = []; let size = 0;
      const body = await timeUpload("body", async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            size += value.length; uploadBytes(size);
            if (size > ARCHIVE_CHUNK_BYTES) throw Object.assign(new Error("Upload chunk exceeds 4 MiB"), { statusCode: 413 });
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        return Buffer.concat(chunks);
      });
      return json(await timeUpload("receive", () => writeBinaryChunk(request, versionId, "original", Number(raw), body, url.searchParams.get("final") === "1")));
    } catch (error) { return errorResponse(error); }
  });
}
