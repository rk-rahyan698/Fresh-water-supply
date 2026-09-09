import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Pin the workspace root to this directory.
   *
   * Turbopack infers the root by walking up looking for a lockfile. A stray
   * package-lock.json anywhere above the project - easy to create by running
   * `npm install` in a home directory once - makes it pick that directory
   * instead, and every build then prints
   *
   *   Warning: Next.js ignored package-lock.json in <parent> because it is
   *   outside the current Git repository
   *
   * Setting it explicitly makes the build behave the same on a laptop as it
   * does on Vercel, where the repo root is unambiguous.
   */
  turbopack: {
    root: path.join(import.meta.dirname, "."),
  },

  /**
   * Hosts allowed to load /_next/* dev resources from another origin.
   *
   * Collectors test on their phones over the LAN, which means the browser
   * asks for the dev server by IP rather than localhost. Next blocks that by
   * default, and the failure is quiet and misleading: the page HTML arrives
   * fine, but every JavaScript chunk is refused, React never hydrates, and
   * forms fall back to a native GET - so "Add client" reloads the page with
   * the fields in the query string instead of saving anything.
   *
   * Add whatever address your machine shows next to "Network:" when
   * `npm run dev` starts. Development only - it has no effect on a build or
   * on Vercel.
   */
  allowedDevOrigins: ["192.168.1.91"],
};

export default nextConfig;
