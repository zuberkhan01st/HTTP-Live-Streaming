import { randomUUID } from "node:crypto";
import {
  access,
  constants as fsConstants,
  mkdir,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import cors from "cors";
import express from "express";
import morgan from "morgan";
import multer from "multer";

import {
  patchNestedAbrPlaylists,
  transcodeToHls,
  type LadderMode,
  type RenditionMeta,
} from "./ffmpeg-hls";

const port = Number(process.env.PORT) || 3001;

/** Browser origins allowed to call the API (cross-origin Next dev ↔ API). */
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

const allowedOrigins = parseAllowedOrigins();
/** Pre-joined list for startup log; name kept for hot-reload compat with older listeners. */
const clientOrigin = allowedOrigins.join(", ");

const uploadsDir = join(process.cwd(), "uploads");
const hlsDir = join(process.cwd(), "hls-output");

const uuidRegex = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

function extFromFilename(name: string): string | null {
  const i = name.lastIndexOf(".");
  if (i < 0 || i === name.length - 1) return null;
  return name.slice(i).toLowerCase();
}

const allowedExt = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);

type JobListItem = {
  id: string;
  sourceName: string;
  createdAt: string;
  manifestPath: string;
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

async function listJobs(): Promise<JobListItem[]> {
  try {
    const dirEntries = await readdir(hlsDir, { withFileTypes: true });
    const rows: JobListItem[] = [];

    for (const e of dirEntries) {
      if (!e.isDirectory() || !uuidRegex.test(e.name)) continue;
      const metaPath = join(hlsDir, e.name, "meta.json");
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

function parseLadder(raw: unknown): LadderMode {
  if (raw === "single" || raw === "abr") return raw;
  return "abr";
}

async function repairAbrPlaylistPathsOnStartup(): Promise<void> {
  let entries;
  try {
    entries = await readdir(hlsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !uuidRegex.test(e.name)) continue;
    await patchNestedAbrPlaylists(join(hlsDir, e.name), e.name);
  }
}

await mkdir(uploadsDir, { recursive: true }).catch(() => {});
await repairAbrPlaylistPathsOnStartup();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = extFromFilename(file.originalname) ?? "";
    cb(null, `${randomUUID()}${ext || ".bin"}`);
  },
});

const uploadMw = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
}).single("file");

const app = express();

app.set("trust proxy", 1);

app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "OPTIONS"],
    // Omit allowedHeaders so cors mirrors Access-Control-Request-Headers (multipart uploads).
    credentials: false,
  }),
);

app.use(
  morgan(process.env.NODE_ENV === "production" ? "combined" : "dev", {
    skip: (req) => req.method === "GET" && req.url === "/health",
  }),
);

const hlsGate = express.Router();
hlsGate.use((req, res, next) => {
  const clean = req.path.replace(/^\//, "");
  const [jobId, ...segments] = clean.split("/");
  if (
    !jobId ||
    !uuidRegex.test(jobId) ||
    segments.length === 0 ||
    segments.some((s) => s.includes("..") || s.length === 0)
  ) {
    res.status(400).send("Bad Request");
    return;
  }
  next();
});
hlsGate.use(
  express.static(hlsDir, {
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

app.use("/hls", hlsGate);

app.get("/", (_req, res) => {
  res.json({
    service: "hls-backend",
    stack: "Express",
    logging: "morgan (terminal) + [hls job=…] pipeline milestones",
    health: `/health`,
    upload: "POST /api/upload (multipart: file, ladder=abr|single)",
    jobs: "GET /api/jobs",
    hls: "GET /hls/:jobId/master.m3u8 | index.m3u8",
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/jobs", async (_req, res) => {
  const jobs = await listJobs();
  res.json({ jobs });
});

app.post("/api/upload", (req, res) => {
  uploadMw(req, res, async (err) => {
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

    const file = req.file;
    if (!file) {
      console.error("[upload] missing multipart field file");
      res.status(400).json({ error: "Expected multipart field `file`" });
      return;
    }

    const id = file.filename.includes(".")
      ? file.filename.slice(0, file.filename.lastIndexOf("."))
      : file.filename;

    const extDisk = extFromFilename(file.filename) ?? "";
    const extDeclared = extFromFilename(file.originalname);
    const extUse = extDeclared ?? extDisk;

    const inputPath = file.path;

    if (!extUse || !allowedExt.has(extUse)) {
      console.error("[upload] bad extension", file.originalname, file.filename);
      await unlink(inputPath).catch(() => {});
      res.status(400).json({
        error: `Unsupported extension. Allowed: ${[...allowedExt].join(", ")}`,
      });
      return;
    }

    const sizeBytes =
      typeof file.size === "number" && Number.isFinite(file.size) ? file.size : null;
    console.log(
      `[hls job=${id}] upload_ok source=${JSON.stringify(file.originalname)} ladder=${ladder} bytes=${sizeBytes ?? "unknown"}`,
    );

    const outDir = join(hlsDir, id);

    try {
      await mkdir(outDir, { recursive: true });
      console.log(`[hls job=${id}] output_dir ${outDir}`);
      const result = await transcodeToHls(inputPath, outDir, id, ladder);

      await unlink(inputPath).catch(() => {});

      const manifestPath = `/hls/${id}/${result.manifestFile}`;
      await writeFile(
        join(outDir, "meta.json"),
        JSON.stringify(
          {
            id,
            sourceName: file.originalname,
            createdAt: new Date().toISOString(),
            manifest: result.manifestFile,
            ladder: result.ladder,
            renditions: result.renditions,
          },
          null,
          2,
        ),
        "utf-8",
      );

      const host = `${req.protocol}://${req.get("host") ?? "localhost"}`;

      res.json({
        ok: true,
        id,
        sourceName: file.originalname,
        manifestPath,
        manifestUrl: `${host}${manifestPath}`,
        ladder: result.ladder,
        renditions: result.renditions,
      });
      console.log(`[hls job=${id}] response_ok manifest=${manifestPath}`);
    } catch (transErr) {
      const message =
        transErr instanceof Error ? transErr.message : String(transErr);
      console.error(`[hls job=${id}] transcode_failed`, message.slice(0, 800));

      await unlink(inputPath).catch(() => {});
      await rm(outDir, { recursive: true, force: true }).catch(() => {});

      res.status(500).json({
        error: "Transcode failed",
        detail: message,
      });
    }
  });
});

app.use((_req, res) => {
  res.status(404).send("Not Found");
});

app.listen(port, () => {
  console.log(
    `HLS API → http://localhost:${port}  |  CORS origins: ${clientOrigin}  |  morgan ${process.env.NODE_ENV === "production" ? "combined" : "dev"}`,
  );
});