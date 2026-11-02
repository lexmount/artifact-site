/** Bounded-memory hashing also makes reselect/resume independent of name and timestamps. */
const CHUNK = 4 * 1024 * 1024;
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
const digest = async (blob: Blob) => hex(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
export async function archiveFingerprint(file: Blob) {
  // HTTP self-hosts lack Web Crypto. Their resumed prefix is verified by replaying it to the server.
  if (!globalThis.crypto?.subtle) return `server-verified:${file.size}`;
  const hashes = [];
  for (let offset = 0; offset < file.size; offset += CHUNK) hashes.push(await digest(file.slice(offset, offset + CHUNK)));
  return digest(new Blob([JSON.stringify([file.size, hashes])]));
}
export async function uploadArchiveChunks(request: typeof fetch, versionId: string, file: File, headers: HeadersInit, progress: (bytes: number) => void, t: (message: string) => string) {
  const read = async (res: Response) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t("Upload interrupted. Select the same file again to resume."));
    return data;
  };
  const send = async (index: number, body: Blob, final: boolean) => {
    for (let attempt = 0; ; attempt++) {
      const response = await request(`/api/uploads/${versionId}/chunks?index=${index}&final=${final ? 1 : 0}`, { method: "PUT", headers, body }).catch(() => null);
      if (response?.ok) { await read(response); break; }
      if (response && ![408, 409, 429, 500, 502, 503, 504, 524].includes(response.status)) { await read(response); break; }
      if (attempt >= 3) {
        if (response?.status === 409) await read(response);
        throw new Error(t("Upload interrupted. Select the same file again to resume."));
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(8000, 1000 * 2 ** attempt)));
    }
  };
  const state = await read(await request(`/api/uploads/${versionId}`, { headers }));
  const partial = state.partialFiles?.find((p: { path: string }) => p.path === "original");
  let offset = 0, index = 0;
  for (const chunk of partial?.chunks ?? []) {
    if (offset + chunk.bytes > file.size || (globalThis.crypto?.subtle && (!chunk.sha256 || await digest(file.slice(offset, offset + chunk.bytes)) !== chunk.sha256))) throw new Error(t("The selected file differs from the uploaded chunks. Start a new upload."));
    if (!globalThis.crypto?.subtle) await send(index, file.slice(offset, offset + chunk.bytes), Boolean(partial.sealed && index === partial.chunks.length - 1));
    offset += chunk.bytes; index++;
  }
  progress(offset);
  if (partial?.sealed) {
    if (offset !== file.size) throw new Error(t("The selected file differs from the uploaded chunks. Start a new upload."));
    return;
  }
  do {
    const end = Math.min(offset + CHUNK, file.size), body = file.slice(offset, end);
    await send(index, body, end === file.size);
    offset = end; index++; progress(offset);
  } while (offset < file.size);
}
