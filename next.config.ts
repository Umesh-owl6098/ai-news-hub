import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.unsplash.com",
      },
    ],
  },
  experimental: {
    // Step 29 audit finding: the App Router's client-side Router Cache
    // (default: 30s for dynamic routes) let a user bookmark/queue an item
    // on /queue or /briefing, open its detail page, then hit Back and see
    // the STALE pre-toggle state — the self-contained toggle buttons
    // (BookmarkButton/QueueButton/ReadToggleButton) re-render from the
    // cached RSC payload captured at the original page load, not from
    // fresh persisted data. Reproduced and confirmed via a real click-
    // through on /queue. Setting `dynamic: 0` makes every dynamic-route
    // back/forward navigation refetch fresh server data instead of
    // reusing a stale client cache — the correctness this app's read
    // paths already assume (every persisted read is sub-millisecond at
    // this corpus size, so the round-trip cost is negligible). `static`
    // is left at its default (prefetched Link navigations, unaffected by
    // this bug, keep their normal caching).
    staleTimes: {
      dynamic: 0,
    },
  },
};

export default nextConfig;
