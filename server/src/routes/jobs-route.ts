import { access, constants as fsConstants, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Router } from "express";

import { UUID_REGEX } from "../constants";
import type { LadderMode, RenditionMeta } from "../ffmpeg-hls";
import { listJobsSorted } from "../job-registry";
import { resolveJobManifestPublicUrl } from "../playback-url";

export type JobListItem = {
  id: string;
  sourceName: string;
  createdAt: string;
  manifestPath: string;
  manifestPublicUrl?: string | null;
  ladder: LadderMode;
  renditions: RenditionMeta[];
};

async function pathExists(metaPath: string): Promise<boolean> {
  try {
    await access(metaPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function listJobsFromDisk(hlsDiskDir: string): Promise<JobListItem[]> {
  try {
    const dirEntries = await readdir(hlsDiskDir, { withFileTypes: true });
    const rows: JobListItem[] = [];

    for (const e of dirEntries) {
      if (!e.isDirectory() || !UUID_REGEX.test(e.name)) continue;
      const metaPath = join(hlsDiskDir, e.name, "meta.json");
      if (!(await pathExists(metaPath))) continue;
      try {
        const raw = await readFile(metaPath, "utf-8");
        const meta = JSON.parse(raw) as {
          sourceName?: string;
          createdAt?: string;
          manifest?: string;
          ladder?: LadderMode;
          renditions?: RenditionMeta[];
        };
        const manifestFile = meta.manifest ?? "index.m3u8";
        rows.push({
          id: e.name,
          sourceName: meta.sourceName ?? "unknown",
          createdAt: meta.createdAt ?? new Date(0).toISOString(),
          manifestPath: `/hls/${e.name}/${manifestFile}`,
          ladder: meta.ladder ?? "single",
          renditions: meta.renditions ?? [
            {
              label: "720p",
              height: 720,
              videoBitrateKbps: 2800,
              audioBitrateKbps: 128,
            },
          ],
        });
      } catch {
        continue;
      }
    }

    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return rows;
  } catch {
    return [];
  }
}

export async function listAllJobs(useCloudStorage: boolean, hlsDiskDir: string): Promise<JobListItem[]> {
  if (useCloudStorage) {
    const jobs = await listJobsSorted();
    return jobs.map(
      (j): JobListItem => ({
        id: j.id,
        sourceName: j.sourceName,
        createdAt: j.createdAt,
        manifestPath: j.manifestPath,
        manifestPublicUrl: resolveJobManifestPublicUrl(
          j.id,
          j.manifestPath,
          j.manifestPublicUrl,
          j.firebasePlaybackToken,
        ),
        ladder: j.ladder,
        renditions: j.renditions,
      }),
    );
  }
  return listJobsFromDisk(hlsDiskDir);
}

export function createJobsRouter(useCloudStorage: boolean, hlsDiskDir: string): Router {
  const router = Router();

  router.get("/jobs", async (_req, res) => {
    const jobs = await listAllJobs(useCloudStorage, hlsDiskDir);
    res.json({ jobs });
  });

  return router;
}
