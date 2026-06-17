"use client";

import { HlsPlayer } from "@/components/HlsPlayer";
import { getApiBase } from "@/lib/api-base";
import { firebaseStorageSiblingUriFromMaster } from "@/lib/firebase-storage-media-url";
import { useCallback, useEffect, useMemo, useState } from "react";

type RenditionMeta = {
  label: string;
  height: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
};

type Job = {
  id: string;
  sourceName: string;
  createdAt: string;
  manifestPath: string;
  /** When set, playlists and segments bypass the Express `/hls` proxy and load straight from HTTPS (GCS). */
  manifestPublicUrl?: string | null;
  ladder: "abr" | "single";
  renditions: RenditionMeta[];
};

type UploadResult = {
  ok: true;
  id: string;
  sourceName: string;
  manifestPath: string;
  /** Primary playback URL (public CDN if configured, otherwise API `/hls/...` proxy). */
  manifestUrl: string;
  manifestPublicUrl?: string | null;
  manifestProxyUrl?: string;
  ladder: "abr" | "single";
  renditions: RenditionMeta[];
};

type JobsFetchResult =
  | { ok: true; jobs: Job[] }
  | { ok: false; error: string };

type LadderChoice = "abr" | "single";

async function fetchJobsList(
  api: string,
  signal?: AbortSignal,
): Promise<JobsFetchResult> {
  try {
    const res = await fetch(`${api}/api/jobs`, { cache: "no-store", signal });
    const data = (await res.json()) as { jobs?: Job[]; error?: string };
    if (!res.ok) {
      return { ok: false, error: data.error ?? res.statusText };
    }
    return { ok: true, jobs: data.jobs ?? [] };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw e;
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Failed to load jobs",
    };
  }
}

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Absolute manifest URL — direct HTTPS when API sets manifestPublicUrl. */
function effectiveManifestPlaybackUrl(
  apiBase: string,
  job: Pick<Job, "manifestPath" | "manifestPublicUrl">,
): string {
  const pub = job.manifestPublicUrl?.trim();
  if (pub) return pub;
  return `${apiBase}${job.manifestPath}`;
}

/** Parent folder URL so variant playlists like stream_1.m3u8 resolve beside master. */
function derivePlaylistFolderUrl(manifestAbsoluteUrl: string): string {
  try {
    const u = new URL(manifestAbsoluteUrl);
    const slash = u.pathname.lastIndexOf("/");
    u.pathname = u.pathname.slice(0, slash + 1);
    return u.href.endsWith("/") ? u.href : `${u.href}/`;
  } catch {
    const i = manifestAbsoluteUrl.lastIndexOf("/");
    return i > 8 ? `${manifestAbsoluteUrl.slice(0, i + 1)}` : manifestAbsoluteUrl;
  }
}

/** Playlists / segments fetched straight from HTTPS storage (browser bypasses `{api}/hls/…`). */
function playbackIsDirectGcs(job: Pick<Job, "manifestPublicUrl">): boolean {
  return Boolean(job.manifestPublicUrl?.trim());
}

export function Dashboard() {
  const api = useMemo(() => getApiBase(), []);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ladder, setLadder] = useState<LadderChoice>("abr");

  const syncJobsFromFetch = useCallback((result: JobsFetchResult) => {
    if (result.ok) {
      setLoadError(null);
      setJobs(result.jobs);
      setSelectedId((prev) => prev ?? result.jobs[0]?.id ?? null);
    } else {
      setLoadError(result.error);
    }
  }, []);

  const refreshJobs = useCallback(async () => {
    syncJobsFromFetch(await fetchJobsList(api));
  }, [api, syncJobsFromFetch]);

  useEffect(() => {
    const ac = new AbortController();
    fetchJobsList(api, ac.signal)
      .then((result) => {
        if (!ac.signal.aborted) syncJobsFromFetch(result);
      })
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
      });
    return () => ac.abort();
  }, [api, syncJobsFromFetch]);

  const effectivePlaybackId =
    selectedId !== null && jobs.some((j) => j.id === selectedId)
      ? selectedId
      : (jobs[0]?.id ?? null);

  const selected = effectivePlaybackId
    ? jobs.find((j) => j.id === effectivePlaybackId) ?? null
    : null;

  const playUrl = selected ? effectiveManifestPlaybackUrl(api, selected) : "";
  const renditionHints = selected?.renditions.map((r) => r.label) ?? [];

  const safariVariantSources = useMemo(() => {
    if (!selected || selected.ladder !== "abr") return undefined;
    if (!selected.manifestPath.endsWith("master.m3u8")) return undefined;
    const masterAbs = effectiveManifestPlaybackUrl(api, selected);
    const folderUrl = derivePlaylistFolderUrl(masterAbs);
    return selected.renditions.map((r, i) => {
      const leaf = `stream_${i}.m3u8`;
      const url =
        firebaseStorageSiblingUriFromMaster(masterAbs, leaf) ?? `${folderUrl}${leaf}`;
      return {
        idx: i,
        label: `${r.label} (~${r.height}px · ~${r.videoBitrateKbps} kb/s)`,
        url,
      };
    });
  }, [selected, api]);

  async function onSubmitFile(file: File) {
    setUploading(true);
    setUploadError(null);
    setUploadMessage(null);

    const form = new FormData();
    form.set("file", file);
    form.set("ladder", ladder);

    try {
      const res = await fetch(`${api}/api/upload`, {
        method: "POST",
        body: form,
      });
      const body = (await res.json()) as {
        error?: string;
        detail?: string;
        ok?: boolean;
      } & Partial<UploadResult>;

      if (!res.ok) {
        const detail = body.detail ? ` — ${body.detail}` : "";
        throw new Error((body.error ?? "Upload failed") + detail);
      }

      const result = body as UploadResult;
      const variants = result.renditions.map((r) => r.label).join(", ");
      setUploadMessage(
        `Packaged: ${result.sourceName} · ${result.ladder === "abr" ? "ABR" : "Single"} (${variants})`,
      );
      setSelectedId(result.id);
      await refreshJobs();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-full max-w-6xl flex-col gap-10 px-4 py-10 sm:px-6">
      <header className="relative overflow-hidden rounded-3xl border border-slate-700/60 bg-gradient-to-br from-slate-900/90 via-slate-900/50 to-indigo-950/40 p-8 shadow-2xl shadow-black/40">
        <div className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-sky-500/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-16 left-10 h-48 w-48 rounded-full bg-violet-500/10 blur-3xl" />
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-300/80">
          Next · Bun · ffmpeg · HLS
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Production-style HLS console
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-slate-400">
          Upload a mezzanine file and the packaging service builds your ladder (1080p / 720p /
          480p) with a master playlist, or a fast single 720p rung. With Firebase packaging, playback
          usually targets{' '}
          <strong className="text-emerald-200/90">HTTPS on Google Cloud Storage</strong> so playlists
          and TS segments bypass the API host below—only ingest and job lists call{' '}
          <code className="rounded-md bg-black/35 px-1.5 py-0.5 text-xs text-sky-200">{api}</code>.
          Override with{' '}
          <code className="rounded-md bg-black/35 px-1.5 py-0.5 text-[11px] text-violet-200">
            HLS_PROXY_PLAYBACK_ONLY=1
          </code>{' '}
          to stream everything via <strong className="text-slate-200">GET /hls</strong> instead.
        </p>
      </header>

      <section className="grid gap-6 lg:grid-cols-5">
        <div className="rounded-2xl border border-slate-700/80 bg-slate-900/45 p-6 shadow-xl shadow-slate-950/35 backdrop-blur lg:col-span-2">
          <h2 className="text-lg font-medium text-white">Ingest</h2>
          <p className="mt-1 text-sm text-slate-400">
            MP4 · MOV · MKV · WebM · AVI · M4V · requires{" "}
            <code className="rounded bg-black/35 px-1 py-px text-[11px] text-slate-200">ffmpeg</code>
            /
            <code className="rounded bg-black/35 px-1 py-px text-[11px] text-slate-200">ffprobe</code>.
          </p>

          <div className="mt-6 space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Encoding profile
            </label>
            <select
              value={ladder}
              disabled={uploading}
              onChange={(e) => setLadder(e.target.value as LadderChoice)}
              className="w-full rounded-xl border border-slate-600 bg-slate-950/70 px-3 py-2.5 text-sm text-white outline-none ring-sky-500/30 focus:ring-2"
            >
              <option value="abr">
                Adaptive (1080p + 720p + 480p, master.m3u8)
              </option>
              <option value="single">Single 720p ladder (faster turn-around)</option>
            </select>
            <p className="text-[11px] leading-relaxed text-slate-500">
              ABR matches real-world OTT packaging: three H.264 rungs, aligned GOP, independent
              segments, multi-bitrate master index.
            </p>
          </div>

          <label className="mt-6 flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-slate-600 bg-black/25 px-4 py-10 text-center transition hover:border-sky-500/45 hover:bg-slate-950/40">
            <input
              type="file"
              accept=".mp4,.mov,.mkv,.webm,.avi,.m4v,video/*"
              className="hidden"
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void onSubmitFile(f);
              }}
            />
            <span className="rounded-full bg-gradient-to-r from-sky-500/20 to-violet-500/20 px-4 py-1 text-xs font-semibold text-sky-100 ring-1 ring-sky-500/30">
              {uploading ? "Packaging…" : "Drop or choose a clip"}
            </span>
            <span className="text-sm text-slate-400">
              Long jobs block until packaging finishes — check your API terminal for morgan /
              FFmpeg errors.
            </span>
          </label>

          {uploadMessage && (
            <p className="mt-4 rounded-xl bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100 ring-1 ring-emerald-500/20">
              {uploadMessage}
            </p>
          )}
          {uploadError && (
            <p className="mt-4 rounded-xl bg-red-500/12 px-3 py-2 text-sm text-red-100 ring-1 ring-red-500/25">
              {uploadError}
            </p>
          )}
        </div>

        <div className="rounded-2xl border border-slate-700/80 bg-slate-900/45 p-6 shadow-xl shadow-slate-950/35 backdrop-blur lg:col-span-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-medium text-white">Packaged titles</h2>
              <p className="mt-1 text-sm text-slate-400">
                Disk mode writes under{" "}
                <span className="font-mono text-xs text-slate-300">server/hls-output</span>
                · Firebase mode lists packaged jobs from the API registry JSON
              </p>
            </div>
            <button
              type="button"
              onClick={() => void refreshJobs()}
              className="rounded-xl border border-slate-600 bg-slate-950/60 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-100 transition hover:border-sky-400/35"
            >
              Refresh list
            </button>
          </div>

          {loadError && (
            <p className="mt-4 rounded-xl bg-amber-500/10 px-3 py-2 text-sm text-amber-50 ring-1 ring-amber-400/20">
              {loadError}
              <span className="mt-1 block text-xs text-amber-100/80">
                Start the API with <code className="text-amber-50/90">bun run dev:server</code> or{" "}
                <code className="text-amber-50/90">bun run dev</code>.
              </span>
            </p>
          )}

          <ul className="mt-5 max-h-[28rem] space-y-2 overflow-auto pr-1">
            {jobs.length === 0 && !loadError ? (
              <li className="rounded-xl bg-black/30 px-3 py-4 text-sm text-slate-500 ring-1 ring-slate-800/80">
                No packages yet — ingest a file to mint a fresh UUID job.
              </li>
            ) : null}
            {jobs.map((j) => (
              <li key={j.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(j.id)}
                  className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                    j.id === effectivePlaybackId
                      ? "border-sky-500/55 bg-sky-500/10 shadow-lg shadow-sky-950/20"
                      : "border-slate-700/90 bg-black/25 hover:border-slate-500/60"
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="truncate text-sm font-semibold text-white">{j.sourceName}</p>
                    <span className="shrink-0 rounded-md bg-slate-800/80 px-2 py-0.5 font-mono text-[10px] text-slate-400">
                      {j.id.slice(0, 8)}…
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-500">{formatWhen(j.createdAt)}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <span
                      className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                        j.ladder === "abr"
                          ? "bg-violet-500/20 text-violet-100 ring-1 ring-violet-400/30"
                          : "bg-slate-700/70 text-slate-200 ring-1 ring-slate-500/35"
                      }`}
                    >
                      {j.ladder === "abr" ? "Adaptive" : "Single"}
                    </span>
                    {j.renditions.map((r) => (
                      <span
                        key={r.label}
                        className="rounded-md bg-black/35 px-2 py-0.5 text-[10px] font-medium text-sky-100/85 ring-1 ring-slate-700/80"
                      >
                        {r.label}
                        <span className="text-slate-500">
                          {" "}
                          · {r.videoBitrateKbps}k
                          {r.audioBitrateKbps ? ` · aac ${r.audioBitrateKbps}k` : ""}
                        </span>
                      </span>
                    ))}
                  </div>
                  <p className="mt-2 break-all font-mono text-[10px] text-sky-400/85">
                    {effectiveManifestPlaybackUrl(api, j)}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-700/80 bg-slate-900/40 p-6 shadow-xl shadow-slate-950/40 backdrop-blur">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-700/70 pb-4">
          <div className="min-w-0 flex-1 space-y-2">
            <h2 className="text-lg font-medium text-white">Playback</h2>
            <p className="text-sm text-slate-400">
              Firebase/GCS deployments default <code className="text-[11px] text-emerald-200/90">manifestPublicUrl</code> on{" "}
              <code className="text-[11px] text-slate-300">storage.googleapis.com</code> — the embedded
              player hits Google Storage directly. If jobs only expose{" "}
              <code className="text-[11px] text-sky-300/90">{api}/hls/…</code>, set server env{' '}
              <code className="text-[11px] text-violet-200/90">HLS_PROXY_PLAYBACK_ONLY=1</code> explicitly
              (private buckets).
            </p>
          </div>
        </div>

        <div className="mt-5 space-y-2">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Active job for player
          </label>
          <select
            className="w-full max-w-xl rounded-xl border border-slate-600 bg-slate-950/80 px-3 py-2.5 text-sm text-white outline-none ring-sky-500/25 focus:ring-2"
            value={effectivePlaybackId ?? ""}
            disabled={jobs.length === 0}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            {jobs.length === 0 ? (
              <option value="">No packaged jobs yet</option>
            ) : (
              jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.sourceName} · {j.id.slice(0, 8)} · {j.ladder === "abr" ? "ABR" : "720p"}
                </option>
              ))
            )}
          </select>
        </div>

        {!selected ? (
          <p className="mt-6 text-sm text-slate-400">
            Select a packaged asset above — playlists and TS segments load from the manifest URL’s
            origin (GCS/CDN or this API proxy).
          </p>
        ) : (
          <div className="mt-6">
            <div className="mb-4 rounded-xl border border-slate-700/60 bg-black/30 px-3 py-2 text-sm text-slate-300">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-white">{selected.sourceName}</span>
                {playbackIsDirectGcs(selected) ? (
                  <span className="shrink-0 rounded-md bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-100 ring-1 ring-emerald-500/35">
                    Direct · GCS HTTPS
                  </span>
                ) : (
                  <span className="shrink-0 rounded-md bg-violet-500/12 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-100 ring-1 ring-violet-400/35">
                    API proxy · GET /hls
                  </span>
                )}
              </div>
              <p className="mt-1 break-all font-mono text-[11px] leading-snug text-sky-400/90">
                {playUrl}
              </p>
            </div>
            <HlsPlayer
              key={selected.id}
              src={playUrl}
              renditionHints={renditionHints}
              variantSources={safariVariantSources}
              className="aspect-video w-full rounded-2xl bg-black shadow-inner shadow-black ring-1 ring-slate-800"
            />
          </div>
        )}
      </section>

    </main>
  );
}
