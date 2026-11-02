export interface PackageJobStatus {
  versionId: string;
  title: string;
  targetSlug: string | null;
  status: "queued" | "processing" | "failed" | "completed";
  stage: string;
  processedFiles: number;
  totalFiles: number | null;
  attempts: number;
  /** Durable processing round; optional for legacy jobs or completed jobs with a cleared payload. */
  generation?: string;
  retryable: boolean;
  error?: string;
  failure?: { status: number; body: Record<string, unknown> };
  result?: Record<string, unknown>;
  expiresAt: number;
}
