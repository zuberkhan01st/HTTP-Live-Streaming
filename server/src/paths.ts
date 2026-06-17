import { join } from "node:path";

/**
 * Writable area under server package (cwd is `server/` in dev/Docker cwd `/app`).
 * Override with `SERVER_DATA_ROOT` for custom layout.
 */
export function getServerDataRoot(): string {
  const configured = process.env.SERVER_DATA_ROOT?.trim();
  if (configured) return configured;
  return join(process.cwd(), ".data");
}

export function getJobsRegistryDefaultPath(): string {
  return join(getServerDataRoot(), "jobs-registry.json");
}

/** Staging multipart uploads before packaging (Firebase / GCS mode). */
export function getCloudStagingUploadsDir(): string {
  return join(getServerDataRoot(), "staging-uploads");
}

/** Local FFmpeg output directory before uploading to GCS. */
export function getCloudWorkspaceDir(jobId: string): string {
  return join(getServerDataRoot(), "work", jobId);
}

export const uploadsDirLocal = join(process.cwd(), "uploads");
export const hlsDiskDir = join(process.cwd(), "hls-output");
