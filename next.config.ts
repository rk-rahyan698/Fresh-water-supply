import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
