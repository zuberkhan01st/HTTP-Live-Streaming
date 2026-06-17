import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { LadderMode, RenditionMeta } from "./ffmpeg-hls";
import { getJobsRegistryDefaultPath } from "./paths";

const REGISTRY_VERSION = 1 as const;

/** API mirrors meta.json listing; manifestPath stays /hls/... for API proxy playback. */
export type JobRegistryEntry = {
  id: string;
  sourceName: string;
  createdAt: string;
  manifestPath: string;
  /** When set, browsers may load playlists/segments straight from HTTPS storage/CDN. */
  manifestPublicUrl?: string | null;
  /** Stored on packaged Firebase jobs — used to reconstruct `manifestPublicUrl` when it is absent. Same token is embedded in playlists and object metadata (`firebaseStorageDownloadTokens`). */
  firebasePlaybackToken?: string | null;
  ladder: LadderMode;
  renditions: RenditionMeta[];
  /** Prefix inside GCS/Firebase bucket (optional; for debugging). */
  storagePrefix?: string;
};

export type JobRegistryFile = {
  version: typeof REGISTRY_VERSION;
  jobs: JobRegistryEntry[];
};

export function getRegistryPath(): string {
  const explicit = process.env.JOB_REGISTRY_PATH?.trim();
  if (explicit) return explicit;
  return getJobsRegistryDefaultPath();
}

async function atomicWrite(targetPath: string, body: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, body, "utf-8");
  await rename(tmp, targetPath);
}

/** Load registry JSON (empty if missing/corrupt). */
export async function loadJobRegistry(): Promise<JobRegistryFile> {
  const path = getRegistryPath();
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as JobRegistryFile;
    if (parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.jobs)) {
      return { version: REGISTRY_VERSION, jobs: [] };
    }
    return parsed;
  } catch {
    return { version: REGISTRY_VERSION, jobs: [] };
  }
}

export async function listJobsSorted(): Promise<JobRegistryEntry[]> {
  const { jobs } = await loadJobRegistry();
  const rows = [...jobs];
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return rows;
}

export async function appendJobEntry(entry: JobRegistryEntry): Promise<void> {
  const path = getRegistryPath();
  const prev = await loadJobRegistry();
  const next: JobRegistryFile = {
    version: REGISTRY_VERSION,
    jobs: [entry, ...prev.jobs.filter((j) => j.id !== entry.id)],
  };
  await atomicWrite(path, JSON.stringify(next, null, 2));
}

export async function removeJobEntry(jobId: string): Promise<void> {
  const path = getRegistryPath();
  const prev = await loadJobRegistry();
  await atomicWrite(
    path,
    JSON.stringify(
      { version: REGISTRY_VERSION, jobs: prev.jobs.filter((j) => j.id !== jobId) },
      null,
      2,
    ),
  );
}
