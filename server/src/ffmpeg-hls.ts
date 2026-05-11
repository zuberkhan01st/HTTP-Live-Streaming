import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";

export type LadderMode = "abr" | "single";

export type RenditionMeta = {
  label: string;
  height: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
};

export type TranscodeResult = {
  manifestFile: string;
  renditions: RenditionMeta[];
  ladder: LadderMode;
};

const BARE_SEGMENT_LINE = /^segment\d+\.ts$/;

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * FFmpeg's variant HLS muxer often writes media playlists with bare `segmentNNN.ts`
 * while files live under `v0/`, `v1/`, `v2/`. hls.js resolves URLs from the job root, so
 * we rewrite lines to `v{stream}/segmentNNN.ts` when that file exists.
 */
export async function patchNestedAbrPlaylists(
  outputDir: string,
  jobId: string,
): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(outputDir, { withFileTypes: true });
  } catch {
    return false;
  }

  const streamPls = entries
    .filter((e) => e.isFile() && /^stream_(\d+)\.m3u8$/.test(e.name))
    .map((e) => e.name);
  if (streamPls.length === 0) return false;

  let anyJobChange = false;

  for (const name of streamPls) {
    const m = /^stream_(\d+)\.m3u8$/.exec(name);
    if (!m) continue;
    const streamIdx = Number(m[1]);
    const plPath = join(outputDir, name);
    const raw = await readFile(plPath, "utf-8");
    const lines = raw.split("\n");
    let changed = false;
    const next: string[] = [];

    for (const line of lines) {
      const t = line.trim();
      if (!BARE_SEGMENT_LINE.test(t)) {
        next.push(line);
        continue;
      }
      const nestedPath = join(outputDir, `v${streamIdx}`, t);
      if (await fileExists(nestedPath)) {
        changed = true;
        anyJobChange = true;
        next.push(`v${streamIdx}/${t}`);
      } else {
        next.push(line);
      }
    }

    if (changed) {
      const body = next.join("\n");
      await writeFile(plPath, raw.endsWith("\n") ? `${body}\n` : body, "utf-8");
    }
  }

  if (anyJobChange) {
    console.log(
      `[hls job=${jobId}] playlists_patched variant segment URIs → v*/segment*.ts`,
    );
  }
  return anyJobChange;
}

async function hasAudioStream(inputPath: string): Promise<boolean> {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=index",
      "-of",
      "csv=p=0",
      inputPath,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const out = proc.stdout ? (await new Response(proc.stdout).text()).trim() : "";
  const code = await proc.exited;
  return code === 0 && out.length > 0;
}

async function runFfmpeg(
  args: string[],
  cwd: string,
  jobId: string,
  label: string,
): Promise<void> {
  console.log(`[hls job=${jobId}] ffmpeg_start ${label}`);
  const proc = Bun.spawn(["ffmpeg", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });

  const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
  const code = await proc.exited;

  if (code !== 0) {
    const tail = stderr.trim().slice(-4000);
    console.error(`[ffmpeg] job=${jobId} exit=${code}\n`, tail.slice(-1200));
    throw new Error(tail || `ffmpeg exited with code ${code}`);
  }
  console.log(`[hls job=${jobId}] ffmpeg_done ${label}`);
}

async function transcodeSingle(
  inputPath: string,
  outputDir: string,
  jobId: string,
  withAudio: boolean,
): Promise<TranscodeResult> {
  const args: string[] = [
    "-y",
    "-i",
    inputPath,
    "-vf",
    "scale=-2:720:flags=lanczos,format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-profile:v",
    "main",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    "2800k",
    "-maxrate",
    "3000k",
    "-bufsize",
    "4200k",
    "-g",
    "48",
    "-keyint_min",
    "48",
    "-sc_threshold",
    "0",
  ];

  if (withAudio) {
    args.push("-c:a", "aac", "-ar", "48000", "-b:a", "128k");
  } else {
    args.push("-an");
  }

  args.push(
    "-f",
    "hls",
    "-hls_time",
    "6",
    "-hls_playlist_type",
    "vod",
    "-hls_flags",
    "independent_segments",
    "-hls_segment_filename",
    "segment%03d.ts",
    "index.m3u8",
  );

  await runFfmpeg(args, outputDir, jobId, "single-720p");

  return {
    manifestFile: "index.m3u8",
    ladder: "single",
    renditions: [
      {
        label: "720p",
        height: 720,
        videoBitrateKbps: 2800,
        audioBitrateKbps: withAudio ? 128 : 0,
      },
    ],
  };
}

async function transcodeAbr(
  inputPath: string,
  outputDir: string,
  jobId: string,
  withAudio: boolean,
): Promise<TranscodeResult> {
  const renditions: RenditionMeta[] = [
    {
      label: "1080p",
      height: 1080,
      videoBitrateKbps: 5000,
      audioBitrateKbps: withAudio ? 160 : 0,
    },
    {
      label: "720p",
      height: 720,
      videoBitrateKbps: 2800,
      audioBitrateKbps: withAudio ? 128 : 0,
    },
    {
      label: "480p",
      height: 480,
      videoBitrateKbps: 1200,
      audioBitrateKbps: withAudio ? 96 : 0,
    },
  ];

  const filter =
    "[0:v]split=3[v1][v2][v3];" +
    "[v1]scale=-2:1080:flags=lanczos,format=yuv420p[v1o];" +
    "[v2]scale=-2:720:flags=lanczos,format=yuv420p[v2o];" +
    "[v3]scale=-2:480:flags=lanczos,format=yuv420p[v3o]";

  const args: string[] = ["-y", "-i", inputPath, "-filter_complex", filter];

  args.push("-map", "[v1o]");
  if (withAudio) args.push("-map", "0:a:0");
  args.push(
    "-c:v:0",
    "libx264",
    "-preset",
    "medium",
    "-profile:v",
    "main",
    "-pix_fmt",
    "yuv420p",
    "-b:v:0",
    "5000k",
    "-maxrate:v:0",
    "5350k",
    "-bufsize:v:0",
    "7500k",
    "-g",
    "48",
    "-keyint_min",
    "48",
    "-sc_threshold",
    "0",
  );
  if (withAudio) {
    args.push("-c:a:0", "aac", "-ar", "48000", "-b:a:0", "160k");
  }

  args.push("-map", "[v2o]");
  if (withAudio) args.push("-map", "0:a:0");
  args.push(
    "-c:v:1",
    "libx264",
    "-preset",
    "medium",
    "-profile:v",
    "main",
    "-pix_fmt",
    "yuv420p",
    "-b:v:1",
    "2800k",
    "-maxrate:v:1",
    "3000k",
    "-bufsize:v:1",
    "4200k",
    "-g",
    "48",
    "-keyint_min",
    "48",
    "-sc_threshold",
    "0",
  );
  if (withAudio) {
    args.push("-c:a:1", "aac", "-ar", "48000", "-b:a:1", "128k");
  }

  args.push("-map", "[v3o]");
  if (withAudio) args.push("-map", "0:a:0");
  args.push(
    "-c:v:2",
    "libx264",
    "-preset",
    "medium",
    "-profile:v",
    "main",
    "-pix_fmt",
    "yuv420p",
    "-b:v:2",
    "1200k",
    "-maxrate:v:2",
    "1280k",
    "-bufsize:v:2",
    "1800k",
    "-g",
    "48",
    "-keyint_min",
    "48",
    "-sc_threshold",
    "0",
  );
  if (withAudio) {
    args.push("-c:a:2", "aac", "-ar", "48000", "-b:a:2", "96k");
  }

  args.push(
    "-f",
    "hls",
    "-hls_time",
    "6",
    "-hls_playlist_type",
    "vod",
    "-hls_flags",
    "independent_segments",
    "-master_pl_name",
    "master.m3u8",
    "-var_stream_map",
    withAudio ? "v:0,a:0 v:1,a:1 v:2,a:2" : "v:0 v:1 v:2",
    "-hls_segment_filename",
    "v%v/segment%03d.ts",
    "stream_%v.m3u8",
  );

  await runFfmpeg(args, outputDir, jobId, "abr-3r");
  await patchNestedAbrPlaylists(outputDir, jobId);

  return {
    manifestFile: "master.m3u8",
    ladder: "abr",
    renditions,
  };
}

export async function transcodeToHls(
  inputPath: string,
  outputDir: string,
  jobId: string,
  mode: LadderMode = "abr",
): Promise<TranscodeResult> {
  console.log(`[hls job=${jobId}] transcode_begin mode=${mode}`);
  const withAudio = await hasAudioStream(inputPath);
  console.log(`[hls job=${jobId}] probe audio_stream=${withAudio ? "yes" : "no"}`);

  if (mode === "single") {
    const r = await transcodeSingle(inputPath, outputDir, jobId, withAudio);
    console.log(`[hls job=${jobId}] transcode_complete manifest=${r.manifestFile} ladder=single`);
    return r;
  }
  const r = await transcodeAbr(inputPath, outputDir, jobId, withAudio);
  console.log(`[hls job=${jobId}] transcode_complete manifest=${r.manifestFile} ladder=abr`);
  return r;
}
