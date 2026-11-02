import { uploadArchiveChunks } from "@/lib/archive-chunk-client";
import type { PackageJobStatus } from "@/lib/package-job-contract";
import { isPackageJob, waitForPackageJob } from "@/lib/package-job-client";
import { normalizePickedFolder, packageForFiles, checkArchiveSize, packageUploadLimit, type PackagePickedFiles } from "@/lib/package-upload-client";
import { chooseUploadRoute, INLINE_UPLOAD_MAX_BYTES } from "@/lib/upload-route";
import type { Translator } from "@/lib/i18n";
import { ClientQuotaExceeded, quotaDetailsFrom } from "@/lib/quota-client";
export type VersionFile = { path: string; file: File };
export class VersionConflict extends Error {}
/** The server definitively rejected the payload; a corrected payload needs a fresh operation. */
export class VersionUploadRejected extends Error {}
export interface VersionUpload {
  slug: string; expected: string; key: string; files: PackagePickedFiles; official: boolean;
  token?: string | null; session?: string; onSession?: (id: string) => void;
  processing?: (job: PackageJobStatus) => void;
  progress?: (done: number, total: number) => void; t?: Translator;
}
/** Retain key and session after uncertain failures. A retry replays the same write. */
export async function uploadVersion(input: VersionUpload, request: typeof fetch = fetch) {
  input = { ...input, files: normalizePickedFolder(input.files) };
  const t = input.t ?? ((key: string) => key);
  for (const file of input.files) {
    if (file.path.includes("\\") || file.path.split("/").some(segment => !segment || segment === "." || segment === "..")) throw new Error(t("Upload paths must be relative and cannot contain parent-directory segments."));
  }
  const validVersion = (data: Record<string, unknown>) => {
    if (typeof data.versionId !== "string" || !/^[A-Za-z0-9_-]+$/.test(data.versionId)) throw new Error(t("Could not confirm the uploaded version. Retry to check the result."));
    return data as Record<string, unknown> & { versionId: string };
  };
  const packageOptions = packageForFiles(input.files);

  const route = packageOptions ? { kind: "chunked" as const } : chooseUploadRoute(input.files.map(f => ({ path: f.path, size: f.file.size })), INLINE_UPLOAD_MAX_BYTES, t);
  if (route.kind === "error") throw new Error(route.message);
  const headers: Record<string, string> = input.token ? { "x-edit-token": input.token } : {};
  if (packageOptions && !checkArchiveSize(input.files, packageOptions, await packageUploadLimit(request, t, headers))) throw new Error(t("Archive exceeds the server upload limit."));
  const read = async (res: Response, payloadRequest = true) => {
    const raw = await res.json().catch(() => ({}));
    const data = raw && typeof raw === "object" ? raw : {};
    if (res.status === 409 && (data.code === "version_conflict" || data.currentVersionId)) throw new VersionConflict();
    if (!res.ok) {
      const quota = quotaDetailsFrom(data);
      if (quota) throw new ClientQuotaExceeded(quota);
      const message = data.error || t("Uploading the new version failed");
      if (payloadRequest && [400, 413, 415, 422].includes(res.status)) throw new VersionUploadRejected(message);
      throw new Error(message);
    }
    return data;
  };
  const query = `?expected_version=${encodeURIComponent(input.expected)}`;
  const total = input.files.reduce((n, f) => n + f.file.size, 0);
  if (route.kind === "chunked") {
    if (input.session && packageOptions) {
      const response = await request(`/api/uploads/${input.session}`, { headers });
      if (response.ok) {
        const job = await response.json();
        if (isPackageJob(job)) {
          if (job.status === "failed" && job.retryable) await read(await request(`/api/uploads/${input.session}/retry`, { method: "POST", headers }), false);
          return validVersion(await waitForPackageJob(input.session, request, headers, input.processing, read));
        }
      }
    }
    if (input.session) {
      const status = await request(`/api/operations/${encodeURIComponent(input.key)}`, { headers });
      if (status.ok) {
        const operation = await status.json();
        if (operation.status === "completed") return validVersion(operation.result ?? {});
        if (operation.status === "running") throw new Error(t("The upload is still being processed. Retry shortly to check its result."));
      } else if (status.status !== 404) await read(status, false);
    }
    const session = input.session ?? validVersion(await read(await request("/api/uploads", { method: "POST", headers: { ...headers, "content-type": "application/json", "idempotency-key": `${input.key}-start` }, body: JSON.stringify({ slug: input.slug, package: packageOptions }) }))).versionId;
    input.onSession?.(session);
    const chunkedArchive = packageOptions?.source === "archive" && (await (await request("/api/auth/me", { headers })).json()).uploadLimits?.archiveChunks === 1;
    let done = 0;
    for (const f of input.files) {
      if (chunkedArchive) await uploadArchiveChunks(request, session, f.file, headers, bytes => input.progress?.(bytes, total), t);
      else await read(await request(`/api/uploads/${session}/files/${packageOptions?.source === "archive" ? "original" : f.path.split("/").map(encodeURIComponent).join("/")}`, { method: "PUT", headers, body: f.file }));
      done += f.file.size; input.progress?.(done, total);
    }
    const committed = await read(await request(`/api/uploads/${session}/commit${query}${packageOptions ? "&async=1" : ""}`, { method: "POST", headers: { ...headers, "content-type": "application/json", "idempotency-key": input.key }, body: JSON.stringify({ official: input.official }) }));
    return validVersion(isPackageJob(committed) ? await waitForPackageJob(session, request, headers, input.processing, read) : committed);
  }
  const body = new FormData(); body.set("mode", route.kind); body.set("official", String(input.official));
  for (const f of input.files) {
    body.append(route.kind === "folder" ? "files" : "file", f.file, f.file.name);
    if (route.kind === "folder") body.append("paths", f.path);
  }
  const result = await read(await request(`/api/sites/${encodeURIComponent(input.slug)}/versions${query}`, { method: "POST", headers: { ...headers, "idempotency-key": input.key }, body }));
  input.progress?.(total, total); return validVersion(result);
}
