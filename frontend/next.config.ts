import type { NextConfig } from "next";

// NEXT_PUBLIC_DEMO_MODE=1 builds a fully static export for GitHub Pages:
// no backend, no proxy route, assistant answers come from src/lib/demo-backend.ts.
const demo = process.env.NEXT_PUBLIC_DEMO_MODE === "1";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(demo ? { output: "export", basePath: basePath || undefined, trailingSlash: true, images: { unoptimized: true } } : {}),
};

export default nextConfig;
