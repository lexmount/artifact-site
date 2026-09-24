import type { SiteSummary } from "@/lib/types";
import type { SitePermissions } from "@/lib/authz";
import type { FolderState } from "@/lib/folders";
export const DIRECTORY_PAGE_SIZE = 12;
export interface DirectoryQuery {
  page: number;
  q: string;
  sort: "updated" | "title";
  scope: "owned" | "collab" | "public";
  folder: string;
}
export function parseDirectoryQuery(
  params: URLSearchParams,
  scope?: DirectoryQuery["scope"],
): DirectoryQuery {
  const page = Number(params.get("page") ?? 0);
  return {
    page: Number.isSafeInteger(page) ? Math.max(0, Math.min(100000, page)) : 0,
    q: (params.get("q") ?? "").trim().slice(0, 200),
    sort: params.get("sort") === "title" ? "title" : "updated",
    scope: scope ?? (params.get("tab") === "collab" ? "collab" : "owned"),
    folder: (params.get("folder") ?? "all").slice(0, 100),
  };
}
export interface DirectoryPage {
  sites: SiteSummary[];
  permissions: Record<string, SitePermissions>;
  total: number;
  query: DirectoryQuery;
  counts: { all: number; unfiled: number; byId: Record<string, number> };
  folders: FolderState;
}
