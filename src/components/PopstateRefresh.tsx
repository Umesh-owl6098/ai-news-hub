"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Step 29 audit finding: the App Router's client-side Router Cache can
 * serve a stale copy of a route's server-rendered payload on browser
 * Back/Forward navigation (`popstate`), even with `staleTimes.dynamic: 0`
 * in next.config.ts — that config governs Link-based navigation, not the
 * History API. Confirmed reproducible without this fix: queue/bookmark an
 * item, open its detail page, hit Back, and the list row shows the
 * pre-toggle state even though the detail page (and the database) both
 * already show the change. `router.refresh()` re-fetches the current
 * route's data from the server; combined with `useOptimisticToggle`'s
 * `initialValue` re-sync (see that file), this makes Back/Forward always
 * reflect true persisted state.
 *
 * Renders nothing — mounted once in the root layout so every route is
 * covered without each page wiring this up itself.
 */
export function PopstateRefresh() {
  const router = useRouter();

  useEffect(() => {
    const handlePopstate = () => router.refresh();
    window.addEventListener("popstate", handlePopstate);
    return () => window.removeEventListener("popstate", handlePopstate);
  }, [router]);

  return null;
}
