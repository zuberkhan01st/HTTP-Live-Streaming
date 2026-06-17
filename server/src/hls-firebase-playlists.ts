import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { firebaseStorageMediaUrl } from "./playback-url";

const REL_MEDIA = /^(?:stream_\d+\.m3u8|v\d+\/segment\d+\.ts|segment\d+\.ts)$/;

async function collectM3u8RelPaths(absDir: string, relPrefix = ""): Promise<string[]> {
  const entries = await readdir(absDir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const rp = relPrefix ? `${relPrefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push(...(await collectM3u8RelPaths(join(absDir, e.name), rp)));
    } else if (e.isFile() && e.name.endsWith(".m3u8")) {
      out.push(rp);
    }
  }
  return out;
}

/**
 * Rewrite HLS playlists on disk so every media URI is an absolute
 * **`firebasestorage.googleapis.com/.../o/ENCODED?alt=media`** URL under **`{prefix}/{jobId}/`**.
 */
export async function rewriteHlsPlaylistsToFirebaseMediaUrls(
  outputDir: string,
  jobId: string,
  bucket: string,
  storagePrefix: string,
  firebaseDownloadToken?: string,
): Promise<void> {
  const prefix = storagePrefix.replace(/^\/+|\/+$/g, "");
  const playlistRelPaths = await collectM3u8RelPaths(outputDir);
  let touched = 0;

  for (const rel of playlistRelPaths) {
    const path = join(outputDir, rel);
    const raw = await readFile(path, "utf-8");
    const lines = raw.split("\n");
    const out: string[] = [];
    let changed = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.length || trimmed.startsWith("#")) {
        out.push(line);
        continue;
      }
      if (/^https?:\/\//i.test(trimmed)) {
        out.push(line);
        continue;
      }
      if (!REL_MEDIA.test(trimmed)) {
        out.push(line);
        continue;
      }

      const wsEnd = line.search(/\S/);
      const indent = wsEnd === -1 ? "" : line.slice(0, wsEnd);
      const objectKey = `${prefix}/${jobId}/${trimmed}`;
      out.push(`${indent}${firebaseStorageMediaUrl(bucket, objectKey, firebaseDownloadToken)}`);
      changed = true;
    }

    if (changed) {
      const body = out.join("\n");
      await writeFile(path, raw.endsWith("\n") ? `${body}\n` : body, "utf-8");
      touched += 1;
    }
  }

  if (touched > 0) {
    console.log(
      `[hls job=${jobId}] playlists_rewrite_firebase count=${touched} (absolute firebasestorage.googleapis.com URIs for browser HLS resolution)`,
    );
  }
}
