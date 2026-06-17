import { gcsConfigured, getBucketName } from "./gcs";

/**
 * Public playback URL shape for packaged HLS objects.
 *
 * - **Firebase REST (default)** — `firebasestorage.googleapis.com/v0/b/{bucket}/o/{encodeURIComponent(fullObjectPath)}?alt=media` (and **`&token=`** by default; see **`HLS_FIREBASE_PLAYBACK_TOKEN`**).
 *   Master manifests use `%2F` in the `/o/` segment; browsers do **not** resolve relative `#EXT-X-STREAM-INF` URIs
 *   correctly against that base, so we rewrite `.m3u8` playlists to absolute Firebase URLs before GCS upload
 *   (see **`hls-firebase-playlists.ts`**) whenever this mode is active.
 *
 * - **GCS HTTPS** — `https://storage.googleapis.com/<bucket>/<prefix>/…` (set **`HLS_PUBLIC_URL_STYLE=gcs`**).
 *
 * **`HLS_PUBLIC_BASE_URL`** (unless `false`) still wins as a plain path-prefix base (`…/bucket/prefix`).
 *
 * Opt out → proxy manifests only:
 * - **`HLS_PROXY_PLAYBACK_ONLY=1`**
 * - **`HLS_PUBLIC_FROM_BUCKET=0`** (explicit `HLS_PUBLIC_BASE_URL` still works)
 */

function normalizePrefix(p: string): string {
  return p.replace(/^\/+|\/+$/g, "");
}

function explicitPublicBaseUrl(): string | undefined {
  const rawEnv = process.env.HLS_PUBLIC_BASE_URL;
  const raw = typeof rawEnv === "string" ? rawEnv.trim() : "";
  if (!raw || raw.toLowerCase() === "false") return undefined;
  if (!/^https?:\/\//i.test(raw)) return undefined;
  return raw.replace(/\/+$/, "");
}

/** Omit `manifestPublicUrl`; frontend uses API `/hls/…` streaming */
export function proxyPlaybackForced(): boolean {
  const v = process.env.HLS_PROXY_PLAYBACK_ONLY?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Auto-derived playback URLs when bucket configured */
function shouldDerivePublicBaseFromBucket(): boolean {
  if (!gcsConfigured()) return false;
  const v = process.env.HLS_PUBLIC_FROM_BUCKET?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
}

/** `gcs` = path-style URLs; **`firebase`** = Firebase REST `…/v0/b/…/o/… ?alt=media` (default). */
export function hlsDerivedPublicUrlStyle(): "gcs" | "firebase" {
  const v = process.env.HLS_PUBLIC_URL_STYLE?.trim().toLowerCase() ?? "";
  if (v === "gcs" || v === "storage" || v === "googleapis") return "gcs";
  return "firebase";
}

/** `https://storage.googleapis.com/<bucket>/<storagePrefix>` */
function deriveGcsPathBase(): string | undefined {
  if (!gcsConfigured()) return undefined;
  try {
    const bucket = getBucketName();
    const prefix = normalizePrefix(process.env.STORAGE_HLS_PREFIX ?? "hls-packaging");
    return `https://storage.googleapis.com/${bucket}/${prefix}`;
  } catch {
    return undefined;
  }
}

/** When **`HLS_FIREBASE_PLAYBACK_TOKEN=0`**, URLs omit **`&token=`** and uploads skip Firebase download-token metadata. */
export function firebasePlaybackTokensEnabled(): boolean {
  const v = process.env.HLS_FIREBASE_PLAYBACK_TOKEN?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
}

/** Full HTTPS URL for **`alt=media`** downloads (+ optional **`token=`** matching object metadata **`firebaseStorageDownloadTokens`**). */
export function firebaseStorageMediaUrl(
  bucket: string,
  objectKey: string,
  firebaseDownloadToken?: string | null,
): string {
  const key = objectKey.replace(/^\/+/, "").replace(/\\/g, "/");
  const base = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(key)}?alt=media`;
  const t = firebaseDownloadToken?.trim();
  if (!t || !firebasePlaybackTokensEnabled()) return base;
  const u = new URL(base);
  u.searchParams.set("token", t);
  return u.href;
}

/**
 * Rewrite local playlist files before upload so variant + segment URIs resolve in the browser
 * (Firebase master URLs cannot use relative `stream_0.m3u8` lines — see WHATWG URL resolution).
 */
export function shouldRewriteCloudHlsPlaylistsToFirebaseUrls(): boolean {
  if (!gcsConfigured()) return false;
  if (explicitPublicBaseUrl()) return false;
  if (proxyPlaybackForced()) return false;
  if (!shouldDerivePublicBaseFromBucket()) return false;
  return hlsDerivedPublicUrlStyle() === "firebase";
}

export function getHlsPublicBaseUrl(): string | undefined {
  const ex = explicitPublicBaseUrl();
  if (ex) return ex;

  if (proxyPlaybackForced()) return undefined;
  if (!shouldDerivePublicBaseFromBucket()) return undefined;

  try {
    const bucket = getBucketName();
    if (hlsDerivedPublicUrlStyle() === "firebase") {
      return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/`;
    }
    return deriveGcsPathBase();
  } catch {
    return undefined;
  }
}

/** Full URL for the master/index manifest object. */
export function buildManifestPublicUrl(
  jobId: string,
  manifestRelative: string,
  firebaseDownloadToken?: string | null,
): string | undefined {
  const rel = manifestRelative.replace(/^\/+/, "").replace(/\\/g, "/");
  const tailParts = `${jobId}/${rel}`.split("/").filter((s) => s.length > 0);

  const explicit = explicitPublicBaseUrl();
  if (explicit) {
    return `${explicit}/${tailParts.map((s) => encodeURIComponent(s)).join("/")}`;
  }

  if (proxyPlaybackForced()) return undefined;
  if (!shouldDerivePublicBaseFromBucket()) return undefined;

  try {
    const bucket = getBucketName();
    const prefix = normalizePrefix(process.env.STORAGE_HLS_PREFIX ?? "hls-packaging");
    const objectKey = `${prefix}/${tailParts.join("/")}`;
    if (hlsDerivedPublicUrlStyle() === "firebase") {
      const t =
        firebasePlaybackTokensEnabled() && firebaseDownloadToken?.trim()
          ? firebaseDownloadToken.trim()
          : undefined;
      return firebaseStorageMediaUrl(bucket, objectKey, t);
    }
    const gcsSegments = [prefix, ...tailParts];
    return `https://storage.googleapis.com/${bucket}/${gcsSegments.map((s) => encodeURIComponent(s)).join("/")}`;
  } catch {
    return undefined;
  }
}

/** `/hls/{id}/master.m3u8` → `master.m3u8` */
export function manifestRelativeFromProxyPath(jobId: string, manifestPath: string): string {
  const prefix = `/hls/${jobId}/`;
  if (manifestPath.startsWith(prefix)) {
    const rest = manifestPath.slice(prefix.length);
    return rest.length > 0 ? rest : "master.m3u8";
  }
  const last = manifestPath.lastIndexOf("/");
  return last >= 0 ? manifestPath.slice(last + 1) : manifestPath || "master.m3u8";
}

/**
 * Use stored CDN URL when present; otherwise derive from env (so jobs ingested before
 * enabling direct playback pick up URLs without touching the registry file).
 */
export function resolveJobManifestPublicUrl(
  jobId: string,
  manifestPath: string,
  storedManifestPublicUrl: string | null | undefined,
  storedFirebasePlaybackToken?: string | null | undefined,
): string | undefined {
  const trimmed = typeof storedManifestPublicUrl === "string" ? storedManifestPublicUrl.trim() : "";
  if (trimmed) return trimmed;
  const rel = manifestRelativeFromProxyPath(jobId, manifestPath);
  const tok =
    typeof storedFirebasePlaybackToken === "string"
      ? storedFirebasePlaybackToken.trim()
      : undefined;
  return buildManifestPublicUrl(jobId, rel, tok);
}

/** Folder URL ending with "/" for sibling assets (Safari variant trick — GCS URLs only). */
export function derivePlaybackFolderBase(publicManifestUrl: string): string {
  try {
    const u = new URL(publicManifestUrl);
    const slash = u.pathname.lastIndexOf("/");
    if (slash < 0) return `${publicManifestUrl.replace(/\/?$/, "")}/`;
    u.pathname = u.pathname.slice(0, slash + 1);
    return u.href.endsWith("/") ? u.href : `${u.href}/`;
  } catch {
    const i = publicManifestUrl.lastIndexOf("/");
    if (i <= 8) return publicManifestUrl;
    return `${publicManifestUrl.slice(0, i + 1)}`;
  }
}