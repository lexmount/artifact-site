import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { versionDir } from "@/lib/store";
import type { AuditContext } from "@/lib/audit";
import type { UploadFile } from "@/lib/types";

/** A stand-in audit context for tests that exercise editSite/forkSite/etc. directly, below the
 *  route layer that would normally resolve the real actor. method "api" marks it as synthetic. */
export function testAudit(overrides: Partial<AuditContext> = {}): AuditContext {
  return { actor: { kind: "legacy-token", userId: null, anonId: null }, method: "api", ip: null, userAgent: null, ...overrides };
}

export function u8(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

/** {relpath: content} → UploadFile[] for folder-mode uploads. */
export function folderFiles(map: Record<string, string>): UploadFile[] {
  return Object.entries(map).map(([relpath, content]) => ({ relpath, bytes: u8(content) }));
}

/** {relpath: content} → a .zip archive as bytes (for zip-mode uploads). */
export function makeZip(map: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(map)) entries[name] = strToU8(content);
  return zipSync(entries);
}

export function versionFilePath(siteId: string, versionId: string, relpath: string): string {
  return path.join(versionDir(siteId, versionId), relpath);
}

export async function readVersionFile(siteId: string, versionId: string, relpath: string): Promise<string> {
  return readFile(versionFilePath(siteId, versionId, relpath), "utf8");
}

export async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

import type { VersionConflict } from "@/lib/sites";
/** Narrow a write outcome to its committed shape; a null or a VersionConflict fails the test loudly. */
export function committed<T extends object>(r: T | VersionConflict | null | undefined): T {
  if (!r) throw new Error("expected a committed result, got null");
  if ("conflict" in r) throw new Error(`expected a committed result, got a conflict on ${(r as VersionConflict).currentVersionId}`);
  return r;
}
