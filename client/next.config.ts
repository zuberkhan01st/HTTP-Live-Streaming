import type { NextConfig } from "next";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const clientDir = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = join(clientDir, "..");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: monorepoRoot,
  },
};

export default nextConfig;
