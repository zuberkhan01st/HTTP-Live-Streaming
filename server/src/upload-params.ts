import type { LadderMode } from "./ffmpeg-hls";

export function extFromFilename(name: string): string | null {
  const i = name.lastIndexOf(".");
  if (i < 0 || i === name.length - 1) return null;
  return name.slice(i).toLowerCase();
}

export const allowedExtensions = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);

export function parseLadder(raw: unknown): LadderMode {
  if (raw === "single" || raw === "abr") return raw;
  return "abr";
}
