# HTTP Live Streaming (HLS) lab

Monorepo with an **Express** API (runs on Bun), **multer** uploads, **morgan** access logs on the terminal, and a **Next.js** dashboard.

## Prerequisites

- [Bun](https://bun.sh) (see `engines` in root `package.json`)
- **ffmpeg** and **ffprobe** on your `PATH` (required on the machine running `server`)

## Structure

| Package    | Role |
|-----------|------|
| `server/` | Express — `POST /api/upload`, `GET /api/jobs`, `/hls/...`, modular routes under [`server/src/app.ts`](server/src/app.ts) |
| `client/` | Next.js App Router — upload UI, job list, HLS player |

## Setup

```bash
bun install
```

### Environment

- **Client:** copy `client/.env.example` → `client/.env.local` (optional; defaults target `http://127.0.0.1:3001`).
- **Server:** copy `server/.env.example` → `server/.env` (optional; `PORT`, `CLIENT_ORIGIN` or `CLIENT_ORIGINS` for CORS).
- **Firebase / GCS packaging (optional):** set `FIREBASE_STORAGE_BUCKET` or `GCS_BUCKET_NAME` plus a service account (`server/.env.example`). Packaged objects use prefix `STORAGE_HLS_PREFIX/<job-id>/`.

**Playback modes (cloud):**

| Config | Behaviour |
|--------|-----------|
| **Default** (Firebase/GCS bucket set, no opt-out envs) | API returns **`manifestPublicUrl`** as **Firebase REST** (`firebasestorage.googleapis.com/v0/b/<bucket>/o/<encodeURIComponent(prefix%2Fjob%2Fmanifest)>?alt=media` — often with **`&token=<uuid>`** matching object metadata **`firebaseStorageDownloadTokens`**). Uploaded `.m3u8` files use **absolute** URIs so players resolve `#EXT-X-STREAM-INF` and segments. **`HLS_PUBLIC_URL_STYLE=gcs`** switches to **`storage.googleapis.com`** + relative playlists. **`GET /hls`** stays fallback. |
| **`HLS_PROXY_PLAYBACK_ONLY=1`** | **Proxy-only**: no **`manifestPublicUrl`** — browsers must stream through **`GET /hls`** on your API (**private** buckets OK). |
| **`HLS_PUBLIC_FROM_BUCKET=0`** | Disables automatic public URL derivation. You may still set **`HLS_PUBLIC_BASE_URL`**. |

You must configure **Firebase Storage rules** (and sometimes **IAM**) for **anonymous `GET`** on packaged objects, plus **bucket CORS** for your frontend origin, when playback uses **`storage.googleapis.com`** or **`firebasestorage.googleapis.com`** — otherwise manifests return **403** or segments fail in the browser.


**Local data layout:** `SERVER_DATA_ROOT` defaults to **`server/.data`** (staging uploads before GCS packaging, FFmpeg workspace, default `jobs-registry.json` when `JOB_REGISTRY_PATH` is unset). Docker Compose overrides `JOB_REGISTRY_PATH` via a volume (`/data/jobs-registry.json`).

## Scripts (run from repo root)

| Script        | Description |
|---------------|-------------|
| `bun run dev` | Starts API (default `:3001`) and Next (`:3000`) together |
| `bun run dev:server` | API only |
| `bun run dev:client` | Next only |
| `bun run build` | Production build of `client` |
| `bun run start` | Run built Next app (`next start`) |
| `bun run typecheck` | Typecheck `server` and `client` |
| `bun run lint` | ESLint in `client` |
| `bun run clean` | Remove `.next`, `server/uploads`, `server/hls-output`, `server/.data` |
| **Docker Compose** | `docker compose up --build` — see [`compose.yaml`](compose.yaml); pass **`HLS_PROXY_PLAYBACK_ONLY`** etc. as needed |

## Development

```bash
bun run dev
```

Open the Next app URL (printed by `next dev`, usually `http://localhost:3000`). Watch the **`server`** terminal for **morgan** plus **`[hls job=<uuid>] …`** milestones. Set `NEXT_PUBLIC_API_BASE` in `client/.env.local` if the API URL changes.

### Docker Compose (API container)

From the repo root:

```bash
docker compose up --build
```

Optional **`.env`** beside `compose.yaml` — **`FIREBASE_STORAGE_BUCKET`** + credentials, optional **`HLS_PROXY_PLAYBACK_ONLY=1`** if direct playback 403 ([troubleshooting](#403-forbidden-on-browser-playback-firebase--gcs-https)), **`HLS_PUBLIC_URL_STYLE`**, **`API_PORT`** / **`CLIENT_ORIGINS`**, etc.

## Notes

- **Local disk mode** (no `FIREBASE_STORAGE_BUCKET` / `GCS_BUCKET_NAME`): artifacts under `server/hls-output/<job-id>/`; staging uploads under **`server/uploads/`** (both gitignored). Registry is **`meta.json` per folder**.
- **Firebase / GCS mode:** Packaged assets live under `STORAGE_HLS_PREFIX/<job-id>/`. **By default** the API derives **`manifestPublicUrl`** as **Firebase REST** (`firebasestorage.googleapis.com/v0/b/.../o/...?alt=media`) and rewrites uploaded `.m3u8` files to **absolute** URLs so players resolve variants/segments. Set **`HLS_PUBLIC_URL_STYLE=gcs`** for classic **`storage.googleapis.com/<bucket>/<prefix>/...`** URLs and **relative** playlists. **`GET /hls/...`** stays as a fallback. Use **`HLS_PROXY_PLAYBACK_ONLY=1`** to omit **`manifestPublicUrl`**. **Re-upload** jobs packaged before enabling Firebase-style URLs if playlists on disk are still relative-only.

- **Docker / Compose uploads:** Logs should progress **`gcs_upload_begin`** → **`gcs_upload_progress`** → **`gcs_upload_complete`**, then **`gcs_upload_ok`** and **`response_ok`**. Seeing **`transcode_complete`** alone with **`GET /api/jobs` as `{"jobs":[]}`** usually means upload is **still running** or GCS/auth failed (**`gcs_upload_error`**). Verify **`GCP_SERVICE_ACCOUNT_JSON_B64`** / **`GOOGLE_APPLICATION_CREDENTIALS`**. Optionally set **`GCS_UPLOAD_CONCURRENCY`** (see `server/.env.example`).
- **Playback diagnostics:** **`[hls delivery]`** lines show whether bytes are **`gcp_via_server_sdk`** (API streams from Firebase/GCS via the SDK) or **`local_disk_via_express_static`**. Default verbosity logs **playlist** requests only (**`HLS_LOG_DELIVERY=manifests`** or unset). Set **`HLS_LOG_DELIVERY=all`** to mirror every **`GET /hls/...`** segment request (**`HLS_LOG_ALL_HLS=1`** is equivalent).

### CORS errors when loading from Firebase / GCS URLs

Playback uses **`crossOrigin="anonymous"`** when the manifest is on **`firebasestorage.googleapis.com`** or **`storage.googleapis.com`**, so every playlist/segment response must satisfy **bucket CORS**. You **cannot** fix that with React/Next code alone — Google must return **`Access-Control-Allow-Origin`** for your site.

`hls.js` and native HLS use **Range** requests (**`206 Partial Content`**). If the bucket CORS **`responseHeader`** list does **not** include **`Content-Range`** (and related headers), browsers may treat the response as not CORS-visible and surface a **CORS error** / **0 kB** even when the status looks like **206**.

**Workarounds:**

1. **Configure CORS on the bucket** (recommended for direct GCP playback): use **`gsutil`** or **Google Cloud Console → Cloud Storage → your bucket → CORS**. Example `cors.json` — add your deployed origins alongside localhost:

   ```json
   [
     {
       "origin": ["http://localhost:3000", "http://127.0.0.1:3000"],
       "method": ["GET", "HEAD", "OPTIONS"],
       "responseHeader": [
         "Content-Type",
         "Content-Length",
         "Content-Encoding",
         "Content-Disposition",
         "Range",
         "Accept-Ranges",
         "Content-Range",
         "Transfer-Encoding",
         "x-goog-hash",
         "x-goog-meta-firebasestorage"
       ],
       "maxAgeSeconds": 3600
     }
   ]
   ```

   Apply (replace bucket name):

   ```bash
   gsutil cors set cors.json gs://blueprint-v1-c4f3e.firebasestorage.app
   ```

   Then hard-refresh / clear cache. **Firebase Console UI does not replace this** — the JSON lives on the **GCS bucket** backing Firebase Storage.

2. **Bypass browser→GCS entirely:** set **`HLS_PROXY_PLAYBACK_ONLY=1`** on the API so the player loads **`GET /hls/...`** from your backend (already CORS-allowed via **`CLIENT_ORIGINS`**). Heavy for the API, but no Firebase CORS tuning.

### 403 Forbidden on browser playback (Firebase / GCS HTTPS)

Browsers typically load manifests as **`https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<encoded-object-path>?alt=media`** (this project’s **default**) or **`https://storage.googleapis.com/<bucket>/<prefix>/...`** (**`HLS_PUBLIC_URL_STYLE=gcs`**). An XML **403** means **anonymous read is denied**.

**Option A — stay private (no rule changes):** set **`HLS_PROXY_PLAYBACK_ONLY=1`** on the server. The dashboard will use **`GET /hls/...`** on your API again (service account reads GCS server-side).

**Option B — open reads for packaged HLS (typical for public VoD):**

1. **Firebase Storage rules** (Console → Storage → Rules). Allow read on your packaging prefix (match your `STORAGE_HLS_PREFIX`, default `hls-packaging`):

   ```text
   rules_version = '2';
   service firebase.storage {
     match /b/{bucket}/o {
       match /hls-packaging/{allPaths=**} {
         allow read: if true;
         allow write: if false;
       }
     }
   }
   ```

   Tighten `allow read` for production (signed-in users, custom claims, etc.).

2. **CORS** on the bucket (**required** when the dashboard loads playlists/segments from Google in the browser; see [CORS errors when loading from Firebase / GCS URLs](#cors-errors-when-loading-from-firebase--gcs-urls)).

3. If the bucket uses **uniform bucket-level access** and rules are not enough, use **Cloud Console → Cloud Storage → bucket → Permissions** and grant **`allUsers`** the role **Storage Object Viewer** only if you intend world-readable objects (wide exposure).

After rules + CORS, reload the player; **`GET`** on the manifest should succeed in the **browser** tab without a CORS error (not only `curl`).