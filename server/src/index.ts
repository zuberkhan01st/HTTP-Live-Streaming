import { randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import multer from "multer";

import { createApp, getBootstrapClientOriginCsv } from "./app";
import { UUID_REGEX } from "./constants";
import { gcsConfigured } from "./gcs";
import { patchNestedAbrPlaylists } from "./ffmpeg-hls";
import { getRegistryPath } from "./job-registry";
import {
  getCloudStagingUploadsDir,
  getCloudWorkspaceDir,
  getServerDataRoot,
  hlsDiskDir,
  uploadsDirLocal,
} from "./paths";
import { extFromFilename } from "./upload-params";
import { getHlsPublicBaseUrl, hlsDerivedPublicUrlStyle } from "./playback-url";
import { hlsPlaybackLogMode } from "./hls-delivery-log";

const port = Number(process.env.PORT) || 3001;
const useCloudStorage = gcsConfigured();

async function repairDiskAbrPlaylists(): Promise<void> {
  let entries;
  try {
    entries = await readdir(hlsDiskDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !UUID_REGEX.test(e.name)) continue;
    await patchNestedAbrPlaylists(join(hlsDiskDir, e.name), e.name);
  }
}

if (useCloudStorage) {
  const hasCred =
    process.env.GCP_SERVICE_ACCOUNT_JSON ||
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.GCP_SERVICE_ACCOUNT_JSON_B64 ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.FIREBASE_CLIENT_EMAIL;
  console.log(
    `[boot] Packaging → Firebase/Google Cloud Storage (bucket ${process.env.FIREBASE_STORAGE_BUCKET ?? process.env.GCS_BUCKET_NAME})`,
  );
  console.log(`[boot] Job registry JSON → ${getRegistryPath()} (job list)`);
  console.log(`[boot] SERVER_DATA_ROOT → ${getServerDataRoot()}`);
  if (!hasCred) {
    console.warn(
      "[boot] No service-account JSON/B64 nor GOOGLE_APPLICATION_CREDENTIALS set — relying on Application Default Credentials (gcloud/metadata).",
    );
  }
  console.log(
    `[boot] GET /hls/* playback → GCP object stream through this API (fallback / ingest only when browser uses proxy URLs).`,
  );
  const pub = getHlsPublicBaseUrl();
  if (pub) {
    console.log(
      `[boot] Browser playback URL style=${hlsDerivedPublicUrlStyle()} (GET / informative base: ${pub}) — playlists/segments use manifestPublicUrl from /api/jobs.`,
    );
  } else {
    console.log(
      `[boot] Browser playback → via this API GET /hls (proxy-only). Allow public URLs by opening bucket+CORS then unsetting HLS_PROXY_PLAYBACK_ONLY and HLS_PUBLIC_FROM_BUCKET≠0.`,
    );
  }
} else {
  console.log(
    `[boot] GET /hls/* playback → local express.static from disk directory ${hlsDiskDir}`,
  );
}

console.log(
  `[boot] HLS delivery logs → mode=${hlsPlaybackLogMode()} (set HLS_LOG_DELIVERY=all|manifests|off; HLS_LOG_ALL_HLS=1 same as all)`,
);

if (useCloudStorage) {
  await mkdir(getServerDataRoot(), { recursive: true });
  await mkdir(getCloudStagingUploadsDir(), { recursive: true }).catch(() => {});
} else {
  await mkdir(uploadsDirLocal, { recursive: true }).catch(() => {});
  await mkdir(hlsDiskDir, { recursive: true }).catch(() => {});
}

const multerUploadDest = useCloudStorage ? getCloudStagingUploadsDir() : uploadsDirLocal;
await mkdir(multerUploadDest, { recursive: true }).catch(() => {});

if (!useCloudStorage) {
  await repairDiskAbrPlaylists();
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, multerUploadDest),
  filename: (_req, file, cb) => {
    const ext = extFromFilename(file.originalname) ?? "";
    cb(null, `${randomUUID()}${ext || ".bin"}`);
  },
});

const uploadMw = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
}).single("file");

const app = createApp({
  multerMw: uploadMw,
  cloudWorkspace: getCloudWorkspaceDir,
});

const clientOrigin = getBootstrapClientOriginCsv();

app.listen(port, () => {
  console.log(
    `HLS API → http://localhost:${port}  |  CORS origins: ${clientOrigin}  |  morgan ${process.env.NODE_ENV === "production" ? "combined" : "dev"}`,
  );
});
