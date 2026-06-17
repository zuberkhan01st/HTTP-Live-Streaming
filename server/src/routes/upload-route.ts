import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Router, type RequestHandler } from "express";
import multer from "multer";
import type { Request, Response } from "express";

import { allowedExtensions, extFromFilename, parseLadder } from "../upload-params";
import { deleteJobObjects, getBucketName, getJobStoragePrefix, uploadJobDirectory } from "../gcs";
import { transcodeToHls } from "../ffmpeg-hls";
import { appendJobEntry } from "../job-registry";
import { rewriteHlsPlaylistsToFirebaseMediaUrls } from "../hls-firebase-playlists";
import {
  buildManifestPublicUrl,
  firebasePlaybackTokensEnabled,
  shouldRewriteCloudHlsPlaylistsToFirebaseUrls,
} from "../playback-url";

type UploadRouterDeps = {
  multerMw: RequestHandler;
  useCloudStorage: boolean;
  hlsDiskDir: string;
  cloudWorkspace: (jobId: string) => string;
};

export function attachUploadRoutes(router: Router, deps: UploadRouterDeps): void {
  const { multerMw, useCloudStorage, hlsDiskDir, cloudWorkspace } = deps;

  router.post("/upload", (req: Request, res: Response) => {
    multerMw(req, res, async (err: unknown) => {
      if (err instanceof multer.MulterError) {
        console.error("[upload] MulterError", err.code, err.message);
        res.status(400).json({ error: err.message });
        return;
      }
      if (err) {
        console.error("[upload] middleware", err);
        res.status(500).json({ error: "Upload failed" });
        return;
      }

      const ladder = parseLadder(req.body?.ladder);

      const file = req.file as Express.Multer.File | undefined;
      if (!file) {
        console.error("[upload] missing multipart field file");
        res.status(400).json({ error: "Expected multipart field `file`" });
        return;
      }

      const id =
        file.filename.includes(".") ? file.filename.slice(0, file.filename.lastIndexOf(".")) : file.filename;

      const extDisk = extFromFilename(file.filename) ?? "";
      const extDeclared = extFromFilename(file.originalname);
      const extUse = extDeclared ?? extDisk;

      const inputPath = file.path;

      if (!extUse || !allowedExtensions.has(extUse)) {
        console.error("[upload] bad extension", file.originalname, file.filename);
        await unlink(inputPath).catch(() => {});
        res.status(400).json({
          error: `Unsupported extension. Allowed: ${[...allowedExtensions].join(", ")}`,
        });
        return;
      }

      const sizeBytes =
        typeof file.size === "number" && Number.isFinite(file.size) ? file.size : null;
      console.log(
        `[hls job=${id}] upload_ok source=${JSON.stringify(file.originalname)} ladder=${ladder} bytes=${sizeBytes ?? "unknown"}`,
      );

      const outDir = useCloudStorage ? cloudWorkspace(id) : join(hlsDiskDir, id);

      try {
        await mkdir(outDir, { recursive: true });
        console.log(`[hls job=${id}] workspace ${outDir}`);
        const result = await transcodeToHls(inputPath, outDir, id, ladder);

        const firebasePlaybackToken =
          useCloudStorage &&
          shouldRewriteCloudHlsPlaylistsToFirebaseUrls() &&
          firebasePlaybackTokensEnabled()
            ? randomUUID()
            : undefined;

        if (useCloudStorage && shouldRewriteCloudHlsPlaylistsToFirebaseUrls()) {
          await rewriteHlsPlaylistsToFirebaseMediaUrls(
            outDir,
            id,
            getBucketName(),
            process.env.STORAGE_HLS_PREFIX ?? "hls-packaging",
            firebasePlaybackToken,
          );
        }

        await unlink(inputPath).catch(() => {});

        const manifestRelative = result.manifestFile;
        const manifestPath = `/hls/${id}/${manifestRelative}`;
        const host = `${req.protocol}://${req.get("host") ?? "localhost"}`;
        const manifestProxyUrl = `${host}${manifestPath}`;
        const manifestPublicUrl = useCloudStorage
          ? buildManifestPublicUrl(id, manifestRelative, firebasePlaybackToken)
          : undefined;

        const createdAt = new Date().toISOString();

        const metaPayload = {
          id,
          sourceName: file.originalname,
          createdAt,
          manifest: manifestRelative,
          ladder: result.ladder,
          renditions: result.renditions,
        };

        if (useCloudStorage) {
          await uploadJobDirectory(outDir, id, {
            firebaseDownloadToken: firebasePlaybackToken,
          });
          console.log(`[hls job=${id}] gcs_upload_ok prefix=${getJobStoragePrefix(id)}`);
          await rm(outDir, { recursive: true, force: true }).catch(() => {});

          await appendJobEntry({
            id,
            sourceName: file.originalname,
            createdAt,
            manifestPath,
            manifestPublicUrl: manifestPublicUrl ?? null,
            firebasePlaybackToken: firebasePlaybackToken ?? null,
            ladder: result.ladder,
            renditions: result.renditions,
            storagePrefix: getJobStoragePrefix(id),
          });
        } else {
          await writeFile(join(outDir, "meta.json"), JSON.stringify(metaPayload, null, 2), "utf-8");
        }

        /** Primary playback URL — public CDN/storage when configured, otherwise API proxy. */
        const manifestUrl = manifestPublicUrl ?? manifestProxyUrl;

        res.json({
          ok: true as const,
          id,
          sourceName: file.originalname,
          manifestPath,
          manifestPublicUrl,
          manifestProxyUrl,
          manifestUrl,
          ladder: result.ladder,
          renditions: result.renditions,
          storage: useCloudStorage ? `gcs:${getJobStoragePrefix(id)}` : "disk",
        });
        console.log(`[hls job=${id}] response_ok manifest=${manifestPath}`);
      } catch (transErr) {
        const message = transErr instanceof Error ? transErr.message : String(transErr);
        const gcsStage =
          message.includes("GCS upload failed") || /^gcs_upload:/i.test(message);
        console.error(`[hls job=${id}] packaging_failed stage=${gcsStage ? "gcs_upload" : "transcode"}`, message.slice(0, 1200));

        await unlink(inputPath).catch(() => {});
        if (useCloudStorage) {
          await deleteJobObjects(id).catch(() => {});
          await rm(outDir, { recursive: true, force: true }).catch(() => {});
        } else {
          await rm(outDir, { recursive: true, force: true }).catch(() => {});
        }

        res.status(500).json({
          error: gcsStage ? "GCS/Firebase upload failed (see API logs)" : "Transcode failed",
          detail: message,
        });
      }
    });
  });
}
