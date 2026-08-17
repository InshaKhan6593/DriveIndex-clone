import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // The parent repo (driveindex-pipeline/) has its own package-lock.json, and Turbopack's
  // auto-detection walks up to the nearest lockfile — picking that one instead of this
  // app's. That silently pointed the whole build root one level too high, which broke the
  // Tailwind/PostCSS pipeline (globals.css resolved from the wrong directory, so almost no
  // utility classes were ever generated — the entire "everything is oversized" bug).
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
