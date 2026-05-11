"use client";

import type { HlsConfig } from "hls.js";
import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";

export type VariantPlaylistSource = {
  idx: number;
  /** Shown in the quality menu (e.g. "1080p (~1080px · ~5000 kb/s)"). */
  label: string;
  url: string;
};

type Props = {
  src: string;
  className?: string;
  renditionHints?: string[];
  /**
   * ABR variant media playlists (Safari/native HLS has no JS API to pick a rung).
   * When set, users can load `stream_${idx}.m3u8` or keep `src` (master) for Auto.
   * Order must match ffmpeg `stream_%v.m3u8` (0 = highest).
   */
  variantSources?: VariantPlaylistSource[];
};

/** How aggressively ABR tracks measured throughput on VoD. */
export type AbrTuneMode =
  | "balanced"
  | "speed"
  | "stable"
  | "economy_start";

/** Highest height the automaton may pick; still obeys starvation + bandwidth estimate. */
export type HeightCeiling = "none" | 1080 | 720 | 480;

function bufferAhead(video: HTMLVideoElement): number {
  if (!video.duration || Number.isNaN(video.duration)) return 0;
  const t = video.currentTime;
  let best = 0;
  for (let i = 0; i < video.buffered.length; i++) {
    const start = video.buffered.start(i);
    const end = video.buffered.end(i);
    if (t >= start && t <= end) best = Math.max(best, end - t);
    if (t < start && start - t < 0.5) best = Math.max(best, end - t);
  }
  return best;
}

function renditionLabel(height: number, bitrateKbps: number): string {
  let tag = `${height}p`;
  if (height >= 1000 && height <= 1090) tag = "1080p";
  else if (height >= 700 && height <= 770) tag = "720p";
  else if (height >= 450 && height <= 500) tag = "480p";
  return `${tag} · ~${bitrateKbps} kb/s`;
}

function mergeHlsBase(mode: AbrTuneMode): Partial<HlsConfig> {
  switch (mode) {
    case "balanced":
      return {
        lowLatencyMode: false,
        abrEwmaFastVoD: 3,
        abrEwmaSlowVoD: 9,
        abrBandWidthFactor: 0.95,
        abrBandWidthUpFactor: 0.7,
        maxStarvationDelay: 4,
        maxLoadingDelay: 4,
        testBandwidth: true,
      };
    case "speed":
      return {
        lowLatencyMode: false,
        abrEwmaFastVoD: 2,
        abrEwmaSlowVoD: 4,
        abrBandWidthFactor: 0.93,
        abrBandWidthUpFactor: 0.52,
        maxStarvationDelay: 2,
        maxLoadingDelay: 2,
        testBandwidth: true,
        abrMaxWithRealBitrate: true,
      };
    case "stable":
      return {
        lowLatencyMode: false,
        abrEwmaFastVoD: 7,
        abrEwmaSlowVoD: 22,
        abrBandWidthFactor: 0.96,
        abrBandWidthUpFactor: 0.82,
        maxStarvationDelay: 8,
        maxLoadingDelay: 6,
        testBandwidth: true,
      };
    case "economy_start":
      return {
        lowLatencyMode: false,
        abrEwmaFastVoD: 3,
        abrEwmaSlowVoD: 10,
        abrEwmaDefaultEstimate: 280_000,
        abrBandWidthFactor: 0.95,
        abrBandWidthUpFactor: 0.72,
        maxStarvationDelay: 5,
        maxLoadingDelay: 4,
        testBandwidth: true,
      };
    default:
      return { lowLatencyMode: false };
  }
}

/** Highest ladder index whose reported height ≤ ceilPx. */
function capLevelIndex(levelHeights: number[], ceilPx: number): number {
  let chosen = -1;
  for (let i = 0; i < levelHeights.length; i++) {
    const h = levelHeights[i];
    if (h !== undefined && h <= ceilPx) chosen = i;
  }
  return chosen >= 0 ? chosen : 0;
}

const ABR_SUMMARY: Record<AbrTuneMode, string> = {
  balanced: "Default EWMA VoD smoothing.",
  speed: "Tighter EWMA · quicker ups/downs vs throughput.",
  stable: "Wide EWMA · avoids oscillating between rungs.",
  economy_start:
    "~280 kb/s prior estimate · climbs once fragments prove faster pipes.",
};

const CEILING_SUMMARY: Record<HeightCeiling, string> = {
  none: "Auto picks purely from bandwidth + starvation (full ladder).",
  1080: "Never auto-select above ~1080p tier.",
  720: "Good for tether / flaky wi‑fi — prefers mid ladder.",
  480: "Stress-test worst-network playback.",
};

export function HlsPlayer({ src, className, renditionHints, variantSources }: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const tickRef = useRef<() => void>(() => {});
  const [levels, setLevels] = useState<{ idx: number; label: string }[]>([]);
  const [pinned, setPinned] = useState<number | "auto">("auto");
  const [abrMode, setAbrMode] = useState<AbrTuneMode>("balanced");
  const [heightCeiling, setHeightCeiling] = useState<HeightCeiling>("none");

  const [stats, setStats] = useState({
    buf: "",
    bw: "",
    /** One line: rendition + bitrate (~1080p · ~5000 kb/s). */
    tierLine: "",
    /** How chosen: Dynamic (auto) vs manual lock + browser note. */
    modeLine: "",
    tuner: "",
  });

  const pinnedRef = useRef<number | "auto">("auto");
  useEffect(() => {
    pinnedRef.current = pinned;
  }, [pinned]);



  useEffect(() => {
    const video = ref.current;
    if (!video || !src) return undefined;

    const canNative = video.canPlayType("application/vnd.apple.mpegurl") !== "";
    /** hls.js has currentLevel/loadLevel −1 during pure auto — track LEVEL_SWITCHED. */
    let lastAutoLevelIdx = -1;

    function resolvePlayedLevelIndex(hls: Hls): number {
      const pin = pinnedRef.current;
      if (pin !== "auto" && typeof pin === "number") return pin;

      if (hls.loadLevel >= 0) return hls.loadLevel;
      if (hls.currentLevel >= 0) return hls.currentLevel;
      if (lastAutoLevelIdx >= 0) return lastAutoLevelIdx;
      return Math.max(hls.levels.length - 1, 0);
    }

    function tunerLine(hls: Hls | null): string {
      const ceilLabel =
        heightCeiling === "none" ? "no height cap" : `auto ≤ ${heightCeiling}px`;
      if (canNative || !hls) return `${ABR_SUMMARY[abrMode]} · ${ceilLabel} (Safari = OS ABR)`;

      let est = "";
      if (typeof hls.bandwidthEstimate === "number" && hls.bandwidthEstimate > 8000) {
        est = ` · ~${Math.round(hls.bandwidthEstimate / 1000)} kb/s throughput est`;
      }

      return `${ABR_SUMMARY[abrMode]} · ${ceilLabel}${est}`;
    }

    function updateStatsLabel(hls: Hls | null) {
      const v = ref.current;
      if (!v) return;
      const buf = bufferAhead(v);
      const pin = pinnedRef.current;

      if (canNative || !hls) {
        const vw = v.videoWidth;
        const vh = v.videoHeight;
        let tier = "";
        if (vw >= 64 && vh >= 64) {
          tier = `${vw}×${vh} px decoded · ~${vh}px tall`;
          const approxTag = renditionLabel(vh, 1).split(" · ")[0] ?? "";
          if (/^\d+p$/.test(approxTag)) tier += ` (~${approxTag} ladder tag)`;
          if (pin !== "auto" && variantSources?.length) {
            const pv = variantSources.find((s) => s.idx === pin);
            if (pv) tier += ` · locked: ${pv.label}`;
          }
        } else if (renditionHints && renditionHints.length) {
          tier = `Waiting for decoder… encoded ladder — ${renditionHints.join(" · ")}`;
        }

        let modeLine: string;
        if (pin !== "auto" && variantSources?.length) {
          const pv = variantSources.find((s) => s.idx === pin);
          modeLine = pv
            ? `Fixed · playing ${pv.label} only (single-variant HLS). Choose Auto (recommended) to use the master playlist and let Safari adapt.`
            : "Fixed · variant playlist";
        } else if (vw >= 64 && vh >= 64) {
          modeLine =
            "Dynamic · Auto — Safari picks a rung from the master manifest using throughput; the page only sees decoded pixel size, not selected bitrate.";
        } else {
          modeLine =
            "Dynamic · Auto — native HLS (waiting for first decoded frame to show pixel size).";
        }

        setStats({
          buf: `${buf.toFixed(1)}s ahead`,
          bw: "",
          tierLine:
            tier || (renditionHints?.length ? `Ladder: ${renditionHints.join(" · ")}` : "Native HLS"),
          modeLine,
          tuner: tunerLine(hls),
        });
        return;
      }

      const ix = resolvePlayedLevelIndex(hls);
      const cur =
        ix >= 0 && ix < hls.levels.length ? hls.levels[ix] : hls.levels[0];
      const playRes =
        cur !== undefined
          ? renditionLabel(cur.height || 0, Math.max(1, Math.round(cur.bitrate / 1000)))
          : "";

      let bw = "";
      if (cur !== undefined && typeof cur.bitrate === "number") {
        bw = `${Math.round(cur.bitrate / 1000)} kb/s (manifest rung)`;
      }
      const estimate = hls.bandwidthEstimate;
      if (typeof estimate === "number" && estimate > 8000) {
        const kb = Math.round(estimate / 1000);
        bw = bw ? `${bw} · ~${kb} kb/s EWMA est` : `~${kb} kb/s EWMA throughput est`;
      }

      let modeLine: string;
      if (pin === "auto") {
        modeLine = `Dynamic · Auto ABR (level ${ix + 1}/${hls.levels.length}${heightCeiling === "none" ? "" : ` · cap ≤ ${heightCeiling}px`})`;
      } else if (typeof pin === "number") {
        modeLine = `Fixed · quality menu — ladder rung #${pin + 1}/${hls.levels.length} (YouTube-style lock)`;
      } else {
        modeLine = "Selection mode unknown";
      }

      setStats({
        buf: `${buf.toFixed(1)}s ahead`,
        bw,
        tierLine: playRes || "Loading ladder…",
        modeLine,
        tuner: tunerLine(hls),
      });
    }

    const onTick = () => updateStatsLabel(hlsRef.current);
    tickRef.current = onTick;

    if (canNative) {
      const url =
        pinned === "auto" || !variantSources?.length
          ? src
          : (variantSources.find((s) => s.idx === pinned)?.url ?? src);
      video.src = url;
      video.addEventListener("timeupdate", onTick);
      video.addEventListener("progress", onTick);
      setLevels([]);
      updateStatsLabel(null);
      return () => {
        video.removeEventListener("timeupdate", onTick);
        video.removeEventListener("progress", onTick);
        video.removeAttribute("src");
        video.load();
      };
    }

    if (!Hls.isSupported()) {
      console.warn("HLS not supported in this browser.");
      return undefined;
    }

    const cfg: Partial<HlsConfig> = {
      enableWorker: true,
      ...mergeHlsBase(abrMode),
    };

    const hls = new Hls(cfg);
    hlsRef.current = hls;

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      const opts = hls.levels.map((level, idx) => ({
        idx,
        label: renditionLabel(level.height, Math.round(level.bitrate / 1000)),
      }));
      setLevels(opts);
      setPinned("auto");
      lastAutoLevelIdx = 0;

      const heights = hls.levels.map((l) => l.height || 0);
      if (heightCeiling === "none") {
        hls.autoLevelCapping = -1;
      } else {
        hls.autoLevelCapping = capLevelIndex(heights, heightCeiling);
      }

      hls.currentLevel = -1;
      onTick();
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
      if (pinnedRef.current === "auto" && typeof data.level === "number") {
        lastAutoLevelIdx = data.level;
      }
      onTick();
    });

    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) console.error("HLS fatal:", data.type, data.details);
    });

    hls.loadSource(src);
    hls.attachMedia(video);

    video.addEventListener("timeupdate", onTick);
    video.addEventListener("progress", onTick);

    const interval = window.setInterval(() => onTick(), 900);

    return () => {
      window.clearInterval(interval);
      video.removeEventListener("timeupdate", onTick);
      video.removeEventListener("progress", onTick);
      hls.destroy();
      hlsRef.current = null;
      video.removeAttribute("src");
      video.load();
    };
  }, [abrMode, heightCeiling, renditionHints, src, pinned, variantSources]);

  const qualityChoices =
    levels.length > 0
      ? levels.map((l) => ({ value: String(l.idx), label: l.label }))
      : (variantSources ?? []).map((s) => ({ value: String(s.idx), label: s.label }));
  const showAbrLab = levels.length > 0;
  const showQualityMenu = qualityChoices.length > 0;

  function onQualityChange(v: string) {
    const hls = hlsRef.current;
    if (v === "auto") {
      if (hls) hls.currentLevel = -1;
      setPinned("auto");
      queueMicrotask(() => tickRef.current());
      return;
    }
    const i = Number(v);
    if (!Number.isFinite(i)) return;
    if (hls) hls.loadLevel = i;
    setPinned(i);
    queueMicrotask(() => tickRef.current());
  }

  return (
    <div className="space-y-4">
      {showAbrLab ? (
        <div className="grid gap-4 rounded-2xl border border-slate-700/70 bg-black/25 p-4 sm:grid-cols-2">
          <div className="space-y-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Auto ABR tuning
            </span>
            <select
              value={abrMode}
              onChange={(e) => setAbrMode(e.target.value as AbrTuneMode)}
              className="w-full rounded-xl border border-slate-600 bg-slate-950/80 px-3 py-2 text-sm text-white outline-none ring-emerald-500/20 focus:ring-2"
            >
              <option value="balanced">Balanced (default)</option>
              <option value="speed">Speed-first — chain rungs with measured throughput</option>
              <option value="stable">Stable — fewer quality jumps</option>
              <option value="economy_start">Economy ramp — start low, climb when fast</option>
            </select>
            <p className="text-[11px] leading-relaxed text-slate-500">{ABR_SUMMARY[abrMode]}</p>
          </div>
          <div className="space-y-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Max auto height
            </span>
            <select
              value={heightCeiling}
              onChange={(e) => setHeightCeiling(e.target.value as HeightCeiling)}
              className="w-full rounded-xl border border-slate-600 bg-slate-950/80 px-3 py-2 text-sm text-white outline-none ring-sky-500/20 focus:ring-2"
            >
              <option value="none">No cap — full ladder from speed</option>
              <option value="1080">Cap at 1080p tier</option>
              <option value="720">Cap at 720p tier</option>
              <option value="480">Cap at 480p tier</option>
            </select>
            <p className="text-[11px] leading-relaxed text-slate-500">
              {CEILING_SUMMARY[heightCeiling]}
            </p>
          </div>
        </div>
      ) : null}

      {!showAbrLab && showQualityMenu ? (
        <p className="text-xs leading-relaxed text-slate-400">
          <span className="font-medium text-slate-300">Safari native HLS</span> — the quality menu mirrors
          YouTube: stay on <strong className="text-slate-200">Auto</strong> for adaptive playback from the master
          playlist, or pick one line to force a single variant playlist.
        </p>
      ) : null}

      {!showAbrLab && !showQualityMenu && renditionHints && renditionHints.length > 0 ? (
        <p className="text-xs text-slate-400">
          Single packaged bitrate ({renditionHints.join(" · ")}) — multi-quality Auto / manual menu appears on
          ABR jobs where the encoder supplies a ladder.
        </p>
      ) : null}

      {showQualityMenu ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Quality
          </span>
          <select
            value={pinned === "auto" ? "auto" : String(pinned)}
            onChange={(e) => onQualityChange(e.target.value)}
            className="min-w-[12rem] rounded-lg border border-slate-600 bg-slate-950/80 px-3 py-1.5 text-sm text-white"
          >
            <option value="auto">Auto (recommended)</option>
            {qualityChoices.map((q) => (
              <option key={q.value} value={q.value}>
                {q.label}
              </option>
            ))}
          </select>
          <span className="max-w-xl text-[11px] leading-snug text-slate-500">
            {showAbrLab
              ? "With hls.js: Auto adapts inside the EWMA tuner + height cap above. Lock a rung anytime — like YouTube’s quality list."
              : "Auto lets the OS pick a rung from throughput. Locking loads one stream_*.m3u8 so only that rendition plays."}
          </span>
        </div>
      ) : null}

      <div className="space-y-2 rounded-xl border border-slate-800/90 bg-slate-950/40 px-4 py-3 text-slate-400">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Playback quality
          </p>
          <p className="mt-0.5 text-base font-semibold leading-snug text-white">
            {stats.tierLine || "…"}
          </p>
          <p className="mt-1 text-[11px] leading-snug text-sky-400/95">{stats.modeLine}</p>
        </div>
        <p className="text-[10px] leading-snug text-slate-600">
          <span className="font-medium text-slate-500">Pixels vs names like “480p”:</span> the{" "}
          <span className="text-slate-400">853×480</span> figure is decoded frame size (hardware paints W×H
          pixels). “480p / 720p” here matches our encode ladder metadata; Safari Auto does not expose selected
          bitrate or rung index to JavaScript—you infer tier mainly from decoded resolution.
        </p>
        <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-slate-800/80 pt-2 text-[11px]">
          <span>
            Buffer:{" "}
            <strong className="font-medium text-emerald-200/90">{stats.buf}</strong>
          </span>
          {stats.bw ? (
            <span>
              Bandwidth / rung:{" "}
              <strong className="font-medium text-slate-100">{stats.bw}</strong>
            </span>
          ) : null}
        </div>
        <p className="border-t border-slate-800/80 pt-2 text-[10px] leading-relaxed text-slate-500">
          {stats.tuner}
        </p>
      </div>

      <video ref={ref} className={className} controls playsInline preload="metadata" />
    </div>
  );
}
