"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { refreshSourcesAction } from "@/app/actions/refresh";

/**
 * A modest, self-contained refresh trigger for the briefing page — calls
 * the exact same `refreshSourcesAction` the Sidebar's "Refresh sources"
 * control uses (Step 21), never a second refresh implementation. Opening
 * `/briefing` itself never refreshes anything (Step 22 §7); this exists
 * only for the explicit, user-initiated case.
 */
export function BriefingRefreshButton({ compact = false }: { compact?: boolean }) {
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();

  const handleClick = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setMessage(null);
    try {
      const result = await refreshSourcesAction();
      if (result.ok && result.summary) {
        const failed = result.summary.outcomes.filter((o) => o.status === "failed").length;
        setMessage(failed === 0 ? "Refreshed." : `${failed} source(s) failed — see Home for details.`);
        router.refresh();
      } else {
        setMessage(result.error ?? "Couldn't refresh sources. Try again.");
      }
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={refreshing}
        aria-busy={refreshing}
        className={`flex items-center gap-1.5 rounded-lg border border-slate-200 font-medium text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-60 ${
          compact ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm"
        }`}
      >
        <RefreshCw size={compact ? 12 : 14} className={refreshing ? "animate-spin" : ""} />
        {refreshing ? "Refreshing…" : "Refresh sources"}
      </button>
      {message && (
        <span role="status" className="text-xs text-slate-500">
          {message}
        </span>
      )}
    </div>
  );
}
