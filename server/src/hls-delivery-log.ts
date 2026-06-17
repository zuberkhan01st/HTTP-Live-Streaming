/** Controls console lines for `[hls delivery] …` (where bytes come from). */
export type HlsPlaybackLogMode = "off" | "manifests" | "all";

/** HLS_LOG_DELIVERY: off | manifests (default) | all — also respects HLS_LOG_ALL_HLS=1 as alias for all */
export function hlsPlaybackLogMode(): HlsPlaybackLogMode {
  const legacy = process.env.HLS_LOG_ALL_HLS?.trim().toLowerCase();
  if (legacy === "1" || legacy === "true" || legacy === "yes") return "all";

  const v = process.env.HLS_LOG_DELIVERY?.trim().toLowerCase();
  if (!v || v === "manifests" || v === "m3u8" || v === "playlists") return "manifests";
  if (v === "off" || v === "0" || v === "false" || v === "no") return "off";
  if (v === "all" || v === "segments" || v === "full" || v === "verbose") return "all";

  return "manifests";
}

export function shouldLogHlsPlaybackPath(relativeWithinJob: string): boolean {
  const mode = hlsPlaybackLogMode();
  if (mode === "off") return false;
  if (mode === "all") return Boolean(relativeWithinJob);
  return relativeWithinJob.endsWith(".m3u8");
}
