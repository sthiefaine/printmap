import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["three"],
  // Set by the Dockerfile only: a self-contained server for the container.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  // Bottom-left, the default, would cover the export buttons.
  devIndicators: { position: "top-right" },
};

export default nextConfig;
