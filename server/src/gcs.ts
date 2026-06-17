import { Storage } from "@google-cloud/storage";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Request, Response } from "express";

import { shouldLogHlsPlaybackPath } from "./hls-delivery-log";

let storageSingleton: Storage | null = null;

/** True when bucket name is configured (credentials may come from ADC / env JSON). */
export function gcsConfigured(): boolean {
  return !!(
    process.env.FIREBASE_STORAGE_BUCKET?.trim() || process.env.GCS_BUCKET_NAME?.trim()
  );
}

export function getBucketName(): string {
  const b =
    process.env.FIREBASE_STORAGE_BUCKET?.trim() ||
    process.env.GCS_BUCKET_NAME?.trim() ||
    "";
  if (!b) throw new Error("Set FIREBASE_STORAGE_BUCKET or GCS_BUCKET_NAME");
  return b;
}

function parseServiceCredentials(): Record<string, unknown> | undefined {
  const raw =
    process.env.GCP_SERVICE_ACCOUNT_JSON?.trim() ||
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  const b64 = process.env.GCP_SERVICE_ACCOUNT_JSON_B64?.trim();
  if (raw) {
    return JSON.parse(raw.replace(/^\uFEFF?/, "")) as Record<string, unknown>;
  }
  if (b64) {
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  }

  const projectId =
    process.env.FIREBASE_PROJECT_ID?.trim() || process.env.GCP_PROJECT_ID?.trim();
  const email = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  let privateKey =
    process.env.FIREBASE_PRIVATE_KEY?.trim() || process.env.GCP_PRIVATE_KEY?.trim();
  if (privateKey) privateKey = privateKey.replace(/\\n/g, "\n");
  if (projectId && email && privateKey && privateKey.includes("PRIVATE KEY")) {
    return {
      type: "service_account",
      project_id: projectId,
      client_email: email,
      private_key: privateKey,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID?.trim() || "firebase-env",
      client_id: process.env.FIREBASE_CLIENT_ID?.trim() ?? "",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
    };
  }

  return undefined;
}

function getStorage(): Storage {
  if (storageSingleton) return storageSingleton;
  const creds = parseServiceCredentials();
  const projectId =
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    process.env.GCP_PROJECT_ID?.trim() ||
    (typeof creds?.project_id === "string" ? creds.project_id : undefined);

  if (creds) {
    storageSingleton = new Storage({ credentials: creds as object, projectId });
  } else {
    storageSingleton = new Storage(projectId ? { projectId } : undefined);
  }
  return storageSingleton;
}

export function getBucket() {
  return getStorage().bucket(getBucketName());
}

export function storageObjectPrefix(jobId: string, ...segments: string[]): string {
  const base = (process.env.STORAGE_HLS_PREFIX || "hls-packaging").replace(/^\/+|\/+$/g, "");
  const clean = segments
    .flatMap((s) => s.split("/"))
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "." && s !== "..");
  return `${base}/${jobId}/${clean.join("/")}`;
}

function guessContentType(objectPath: string): string {
  const p = objectPath.toLowerCase();
  if (p.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (p.endsWith(".ts")) return "video/mp2t";
  if (p.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

function cacheControl(path: string): string {
  if (path.endsWith(".m3u8")) return "public, max-age=60";
  return "public, max-age=31536000, immutable";
}

function uploadConcurrency(): number {
  const n = Number(process.env.GCS_UPLOAD_CONCURRENCY ?? "8");
  if (!Number.isFinite(n)) return 8;
  return Math.min(24, Math.max(1, Math.floor(n)));
}

async function collectLocalFilePaths(absDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const fp = join(d, e.name);
      if (e.isDirectory()) await walk(fp);
      else out.push(fp);
    }
  }
  await walk(absDir);
  return out.sort();
}

async function runPool<T>(
  items: readonly T[],
  workerCount: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const n = Math.min(workerCount, items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) break;
      await fn(items[idx]!);
    }
  }
  await Promise.all(Array.from({ length: n }, () => worker()));
}

export type UploadJobDirectoryOptions = {
  /** Firebase Storage download token embedded in **`?token=`** URLs; stored as object metadata **`firebaseStorageDownloadTokens`**. */
  firebaseDownloadToken?: string;
};

/** Recursively upload ffmpeg output folder for one job ID (bounded parallelism). */
export async function uploadJobDirectory(
  localRoot: string,
  jobId: string,
  options?: UploadJobDirectoryOptions,
): Promise<void> {
  const t0 = Date.now();
  const absPaths = await collectLocalFilePaths(localRoot);
  const total = absPaths.length;
  const bucket = getBucket();
  const bn = getBucketName();

  console.log(
    `[hls job=${jobId}] gcs_upload_begin bucket=${bn} prefix=${getJobStoragePrefix(jobId)} files=${total}`,
  );

  if (total === 0) {
    throw new Error(`gcs_upload: empty output directory (${localRoot})`);
  }

  const firstRel = relative(localRoot, absPaths[0]!).replace(/\\/g, "/");
  const firstKey = storageObjectPrefix(jobId, ...firstRel.split("/"));
  console.log(`[hls job=${jobId}] gcs_upload_sample_key=${firstKey}`);

  const progressEvery = Math.max(5, Math.min(40, Math.ceil(total / 25)));
  const concurrency = uploadConcurrency();

  /** Progress counter (logged under parallel workers; duplicates are harmless). */
  let done = 0;

  await runPool(absPaths, concurrency, async (absPath: string) => {
    const rel = relative(localRoot, absPath).replace(/\\/g, "/");
    const key = storageObjectPrefix(jobId, ...rel.split("/"));
    try {
      const buf = await readFile(absPath);
      const file = bucket.file(key);
      const ct = guessContentType(rel);
      const metaBase = {
        cacheControl: cacheControl(rel.toLowerCase()),
        contentType: ct,
      };
      await file.save(buf, {
        metadata: options?.firebaseDownloadToken
          ? {
              ...metaBase,
              metadata: {
                firebaseStorageDownloadTokens: options.firebaseDownloadToken,
              },
            }
          : metaBase,
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.error(`[hls job=${jobId}] gcs_upload_error key=${JSON.stringify(key)}`, detail.slice(0, 500));
      throw new Error(`GCS upload failed for ${key}: ${detail}`);
    }

    done += 1;
    const d = done;
    if (d === 1 || d === total || d % progressEvery === 0) {
      console.log(
        `[hls job=${jobId}] gcs_upload_progress ${d}/${total} (${Date.now() - t0}ms elapsed concurrency=${concurrency})`,
      );
    }
  });

  console.log(`[hls job=${jobId}] gcs_upload_complete files=${total} duration_ms=${Date.now() - t0}`);
}

/** Best-effort delete all packaged objects under the job prefix (failed transcodes). */
export async function deleteJobObjects(jobId: string): Promise<void> {
  const bucket = getBucket();
  const base = (process.env.STORAGE_HLS_PREFIX || "hls-packaging").replace(/^\/+|\/+$/g, "");
  const prefix = `${base}/${jobId}/`;
  try {
    const [files] = await bucket.getFiles({ prefix });
    await Promise.all(files.map((f) => f.delete().catch(() => {})));
  } catch {
    /* ignore */
  }
}

export function getJobStoragePrefix(jobId: string): string {
  const base = (process.env.STORAGE_HLS_PREFIX || "hls-packaging").replace(/^\/+|\/+$/g, "");
  return `${base}/${jobId}`;
}

function parseByteRange(
  header: string | undefined,
  totalSize: number,
): { start: number; end: number } | null {
  if (!totalSize || !header?.startsWith("bytes=")) return null;
  const spec = header.slice("bytes=".length).split(",", 1)[0]?.trim();
  if (!spec) return null;
  const dash = spec.indexOf("-");
  if (dash < 0) return null;
  const rs = spec.slice(0, dash).trim();
  const re = spec.slice(dash + 1).trim();
  let start: number;
  let end: number;
  if (rs === "") {
    const suffix = Number(re);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = Number(rs);
    end = re === "" ? totalSize - 1 : Number(re);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start > end || start >= totalSize) return null;
    end = Math.min(end, totalSize - 1);
    if (start > end) return null;
  }
  return { start, end };
}

/** GET object for job proxy (supports Range for players that request partial content). */
export async function streamJobObject(jobId: string, parts: string[], req: Request, res: Response) {
  if (!parts.length || parts.some((p) => p.includes("..") || p.includes("\\"))) {
    res.status(400).send("Bad Request");
    return;
  }

  const key = storageObjectPrefix(jobId, ...parts);
  const relWithinJob = parts.join("/");

  if (shouldLogHlsPlaybackPath(relWithinJob)) {
    const rangeHdr = req.headers.range;
    const rangeNote = rangeHdr
      ? `range=yes (${typeof rangeHdr === "string" ? rangeHdr.slice(0, 40) + (rangeHdr.length > 40 ? "…" : "") : "…"})`
      : "range=no (full object)";
    console.log(
      `[hls delivery] read_from=gcp_via_server_sdk bucket=${getBucketName()} object_key=${key} ` +
        `http_path=/hls/${jobId}/${relWithinJob} ${rangeNote}`,
    );
  }

  const bucket = getBucket();
  const file = bucket.file(key);

  try {
    const [meta] = await file.getMetadata();
    const sizeRaw = meta.size;
    const size =
      typeof sizeRaw === "string" ? Number(sizeRaw) : typeof sizeRaw === "number" ? sizeRaw : 0;

    const contentType = guessContentType(parts[parts.length - 1] ?? "");
    res.setHeader("Accept-Ranges", "bytes");

    const br = parseByteRange(req.headers.range, Number.isFinite(size) ? size : 0);

    if (br && size > 0) {
      res.status(206);
      const len = br.end - br.start + 1;
      res.setHeader("Content-Length", String(len));
      res.setHeader("Content-Range", `bytes ${br.start}-${br.end}/${size}`);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", cacheControl(parts.join("/").toLowerCase()));
      const stream = file.createReadStream({ start: br.start, end: br.end });
      stream.on("error", () => {
        if (!res.headersSent) res.status(404).send("Not Found");
        else res.end();
      });
      stream.pipe(res);
      return;
    }

    res.status(200);
    if (Number.isFinite(size) && size > 0) {
      res.setHeader("Content-Length", String(size));
    }
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", cacheControl(parts.join("/").toLowerCase()));

    const stream = file.createReadStream();
    stream.on("error", () => {
      if (!res.headersSent) res.status(404).send("Not Found");
      else res.end();
    });
    stream.pipe(res);
  } catch (err) {
    if (shouldLogHlsPlaybackPath(relWithinJob)) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[hls delivery] gcp_read_failed object_key=${key}`, msg.slice(0, 280));
    }
    if (!res.headersSent) res.status(404).send("Not Found");
  }
}
