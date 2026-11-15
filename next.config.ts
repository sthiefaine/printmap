import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["three"],
  // Bottom-left, the default, would cover the export buttons.
  devIndicators: { position: "top-right" },
};

export default nextConfig;
