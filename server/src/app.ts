import type { RequestHandler } from "express";

import express from "express";
import cors from "cors";
import morgan from "morgan";

import { gcsConfigured } from "./gcs";
import { getRegistryPath } from "./job-registry";
import { getCloudStagingUploadsDir, getServerDataRoot, hlsDiskDir, uploadsDirLocal } from "./paths";
import { getHlsPublicBaseUrl, hlsDerivedPublicUrlStyle } from "./playback-url";

import { createHlsGateRouter } from "./routes/hls-proxy";
import { attachUploadRoutes } from "./routes/upload-route";
import { createJobsRouter } from "./routes/jobs-route";

function parseAllowedOrigins(): string[] {
  const csv = process.env.CLIENT_ORIGINS?.trim();
  if (csv) {
    return csv
      .split(",")
      .map((s) => s.trim().replace(/\/$/, ""))
      .filter(Boolean);
  }
  const one = process.env.CLIENT_ORIGIN?.trim().replace(/\/$/, "");
  if (one) return [one];
  return ["http://localhost:3000", "http://127.0.0.1:3000"];
}

export type CreateAppDeps = {
  multerMw: RequestHandler;
  cloudWorkspace: (jobId: string) => string;
};

/** Express app with routers; caller runs bootstrap mkdir + listen(). */
export function createApp(deps: CreateAppDeps): express.Application {
  const allowedOrigins = parseAllowedOrigins();
  const useCloudStorage = gcsConfigured();

  const app = express();

  app.set("trust proxy", 1);

  app.use(
    cors({
      origin: allowedOrigins,
      methods: ["GET", "POST", "OPTIONS"],
      credentials: false,
    }),
  );

  app.use(
    morgan(process.env.NODE_ENV === "production" ? "combined" : "dev", {
      skip: (req) => req.method === "GET" && req.url === "/health",
    }),
  );

  app.use("/hls", createHlsGateRouter(useCloudStorage, hlsDiskDir));

  const publicBase = getHlsPublicBaseUrl();
  let storageDescribe: string;
  if (useCloudStorage) {
    storageDescribe =
      publicBase != null
        ? hlsDerivedPublicUrlStyle() === "firebase"
          ? "Firebase / GCS (browser uses manifestPublicUrl → Firebase REST GET …/v0/b/…/o/… ?alt=media; /hls = fallback)"
          : "Firebase / GCS (browser uses manifestPublicUrl → storage.googleapis.com; /hls = fallback)"
        : "Firebase / GCS (browser uses GET /hls proxy — set readable bucket+CORS + unset proxy-only)";
  } else {
    storageDescribe = "local disk (/hls static)";
  }

  app.get("/", (_req, res) => {
    res.json({
      service: "hls-backend",
      stack: "Express",
      storage: storageDescribe,
      jobRegistryJson: useCloudStorage ? getRegistryPath() : null,
      hlsPublicBaseUrl: useCloudStorage ? (publicBase ?? null) : null,
      hlsPublicUrlStyle: useCloudStorage && publicBase != null ? hlsDerivedPublicUrlStyle() : null,
      localDataRoot: getServerDataRoot(),
      stagingUploads: useCloudStorage ? getCloudStagingUploadsDir() : uploadsDirLocal,
      logging: "morgan (terminal) + [hls job=…] pipeline milestones",
      health: `/health`,
      upload: "POST /api/upload (multipart: file, ladder=abr|single)",
      jobs: "GET /api/jobs",
      hls: "GET /hls/:jobId/master.m3u8 | index.m3u8 (proxy or disk)",
    });
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  const api = express.Router();
  api.use("/", createJobsRouter(useCloudStorage, hlsDiskDir));
  attachUploadRoutes(api, {
    multerMw: deps.multerMw,
    useCloudStorage,
    hlsDiskDir,
    cloudWorkspace: deps.cloudWorkspace,
  });

  app.use("/api", api);

  app.use((_req, res) => {
    res.status(404).send("Not Found");
  });

  return app;
}

/** For server/index.ts bootstrap logging */
export function getBootstrapClientOriginCsv(): string {
  return parseAllowedOrigins().join(", ");
}
