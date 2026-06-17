import { join } from "node:path";
import express from "express";

import { UUID_REGEX } from "../constants";
import { streamJobObject } from "../gcs";
import { shouldLogHlsPlaybackPath } from "../hls-delivery-log";

export function createHlsGateRouter(
  useCloudStorage: boolean,
  hlsDiskDir: string,
): express.Router {
  const hlsGate = express.Router();
  hlsGate.use((req, res, next) => {
    const clean = req.path.replace(/^\//, "");
    const [jobId, ...segments] = clean.split("/");
    if (
      !jobId ||
      !UUID_REGEX.test(jobId) ||
      segments.length === 0 ||
      segments.some((s) => s.includes("..") || s.length === 0)
    ) {
      res.status(400).send("Bad Request");
      return;
    }
    next();
  });

  if (useCloudStorage) {
    hlsGate.get(/.*/, (req, res, next) => {
      try {
        const clean = req.path.replace(/^\//, "");
        const [jobId, ...rest] = clean.split("/");
        streamJobObject(jobId, rest, req, res).catch(next);
      } catch (err) {
        next(err);
      }
    });
  } else {
    hlsGate.use((req, _res, next) => {
      const clean = req.path.replace(/^\//, "");
      const [jobId, ...segments] = clean.split("/");
      const rel = segments.filter(Boolean).join("/");
      if (rel.length && shouldLogHlsPlaybackPath(rel)) {
        const absPath = join(hlsDiskDir, jobId, rel);
        console.log(
          `[hls delivery] read_from=local_disk_via_express_static static_root=${hlsDiskDir} path=/hls/${jobId}/${rel} filesystem=${absPath}`,
        );
      }
      next();
    });
    hlsGate.use(
      express.static(hlsDiskDir, {
        etag: true,
        index: false,
        fallthrough: false,
        setHeaders(res, filePath) {
          if (filePath.endsWith(".m3u8")) {
            res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
            res.setHeader("Cache-Control", "public, max-age=60");
          } else if (filePath.endsWith(".ts")) {
            res.setHeader("Content-Type", "video/mp2t");
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          }
        },
      }),
    );
  }

  return hlsGate;
}
