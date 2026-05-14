# HTTP Live Streaming (HLS) lab

Monorepo with an **Express** API (runs on Bun), **multer** uploads, **morgan** access logs on the terminal, and a **Next.js** dashboard.

## Prerequisites

- [Bun](https://bun.sh) (see `engines` in root `package.json`)
- **ffmpeg** and **ffprobe** on your `PATH` (required on the machine running `server`)

## Structure

| Package    | Role |
|-----------|------|
| `server/` | Express — `POST /api/upload`, `GET /api/jobs`, HTTP logs via **morgan**, `/hls/...` static packages |
| `client/` | Next.js App Router — upload UI, job list, HLS player |

## Setup

```bash
bun install
```

### Environment

- **Client:** copy `client/.env.example` → `client/.env.local` (optional; defaults target `http://127.0.0.1:3001`).
- **Server:** copy `server/.env.example` → `server/.env` (optional; `PORT`, `CLIENT_ORIGIN` or `CLIENT_ORIGINS` for CORS). With no CORS env set, both `http://localhost:3000` and `http://127.0.0.1:3000` are allowed so it matches the client default API base on `127.0.0.1`.

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
| `bun run clean` | Remove `.next`, `server/uploads`, `server/hls-output` |
| **Docker Compose** | `docker compose up --build` from repo root — see `compose.yaml` (API on host port `API_PORT` or `3001`, named volumes for `uploads` / `hls-output`) |

## Development

```bash
bun run dev
```

Open the Next app URL (printed by `next dev`, usually `http://localhost:3000`). Watch the **`server`** terminal for **morgan** lines plus **`[hls job=<uuid>] …`** milestones (upload → probe → ffmpeg → done). Set `NEXT_PUBLIC_API_BASE` in `client/.env.local` if the API URL changes.

### Docker Compose (API container)

From the repo root:

```bash
docker compose up --build
```

Optional: add a **`.env`** next to `compose.yaml` with `API_PORT=3001`, `CLIENT_ORIGINS=...`. Media is stored in named Docker volumes (`hls-uploads`, `hls-output`). Shortcuts: **`bun run docker:up`** / **`bun run docker:down`** / **`bun run docker:logs`**.

## Notes

- HLS artifacts live under `server/hls-output/<job-id>/` (gitignored).
- Temporary uploads land in `server/uploads/` (gitignored) and are deleted after a successful transcode.
