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
   * This used to pin a single address, which went stale the moment DHCP handed
   * the laptop a different one - and the symptom is the silent hydration
   * failure described above, not an error that names the origin. Matching the
   * usual private ranges by wildcard instead means it keeps working after a
   * reboot or a move to another network.
   *
   * Development only - it has no effect on a build or on Vercel. If your router
   * uses a range not listed here, check the address next to "Network:" when
   * `npm run dev` starts and add its prefix.
   */
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "172.16.*.*"],
};

export default nextConfig;
