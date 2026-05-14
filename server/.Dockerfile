# syntax=docker/dockerfile:1
#
# Monorepo build — run from repository root:
#   docker build -f server/.Dockerfile -t hls-server .
#

FROM oven/bun:1-slim

# ffmpeg bundles ffprobe on Debian-derived images — no separate ffprobe package
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Cache dependency layer separately from sources
COPY server/package.json server/tsconfig.json ./
RUN bun install --production --ignore-scripts

COPY server/src ./src

RUN mkdir -p uploads hls-output

ENV NODE_ENV=production
ENV PORT=3001
# Override in deploy — see server/.env.example (CLIENT_ORIGIN / CLIENT_ORIGINS)
ENV CLIENT_ORIGIN=http://localhost:3000

EXPOSE 3001

CMD ["bun", "run", "start"]
