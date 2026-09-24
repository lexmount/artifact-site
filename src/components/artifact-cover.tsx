"use client";
import { FileText, Folder, Globe } from "lucide-react";
import type { SiteSummary } from "@/lib/types";
/** Metadata only: never fetch or render uploaded bytes just to draw a list. */
export default function ArtifactCover({
  site,
}: {
  site: Pick<SiteSummary, "kind" | "title">;
}) {
  const Icon =
    site.kind === "document"
      ? FileText
      : site.kind === "folder"
        ? Folder
        : Globe;
  return (
    <div className={`artifact-cover cover-${site.kind}`} aria-hidden="true">
      <Icon size={28} />
      <span>{site.title}</span>
    </div>
  );
}
