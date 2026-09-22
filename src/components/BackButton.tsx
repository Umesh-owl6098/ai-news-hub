"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

/**
 * Returns to whatever the user actually came from (feed, a specific search,
 * a specific page/filter combination) via real browser history — never a
 * hardcoded `/` redirect, which would silently drop their search state.
 * Falls back to `/` only when there's no in-app history to go back to (a
 * direct visit or a reload), since `router.back()` would otherwise leave
 * the app entirely.
 */
export function BackButton() {
  const router = useRouter();

  const handleClick = () => {
    if (window.history.length > 1) router.back();
    else router.push("/");
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label="Back"
      className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
    >
      <ArrowLeft size={16} />
      Back
    </button>
  );
}
