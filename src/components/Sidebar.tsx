"use client";

import Link from "next/link";
import { Home, FileText, Code2, Flame, MessagesSquare, Bookmark, Clock, Tag, Sparkles, RefreshCw, Sunrise } from "lucide-react";
import type { SourceHealthSummary } from "@/db/repository";
import { formatRelativeTime } from "@/lib/time";

interface NavItem {
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  /** A real destination. Items without one stay visual-only (see below) —
   * unlike Home/Bookmarks, which only ever work via `onNavItemClick`'s
   * in-SPA tab switch, an item with `href` always renders as a real link
   * regardless of which page embeds the Sidebar (works both from the main
   * feed/search shell and from the standalone /topics pages). */
  href?: string;
}

/**
 * Step 29 audit: this list previously also included "Latest" (redundant —
 * "Home" already IS the All tab sorted by latest), "Notifications" (no
 * such feature exists in this app, and won't — labeling a button with a
 * feature name that doesn't exist is worse than not having the button),
 * plus entire "Sources" and "Settings" sections whose items had neither
 * an `href` NOR a click handler wired to them at all — clicking any of
 * them did visibly nothing. Every item below now has a real destination;
 * see `handleSidebarNavClick` in DashboardClient.tsx for the tab-mapped
 * ones.
 */
const navItems: NavItem[] = [
  { label: "Home", icon: Home },
  { label: "Briefing", icon: Sunrise, href: "/briefing" },
  { label: "Queue", icon: Clock, href: "/queue" },
  { label: "Papers (arXiv)", icon: FileText },
  { label: "GitHub Repositories", icon: Code2 },
  { label: "Hacker News", icon: Flame },
  { label: "Discussions", icon: MessagesSquare },
  { label: "Bookmarks", icon: Bookmark },
  { label: "My Topics", icon: Tag, href: "/topics" },
];

/**
 * Step 21: a source counts as "Up to date" only if it succeeded within
 * this window — the milestone is explicit that "Up to date" must mean
 * "we refreshed recently," never "upstream definitely has nothing new."
 * 6 hours matches how often a personal single-user news dashboard is
 * realistically refreshed by hand; a success older than that still shows
 * its real last-success time, just under a "Stale" label instead of
 * quietly claiming freshness it can't back up.
 */
const FRESHNESS_THRESHOLD_MS = 6 * 60 * 60 * 1000;

type DisplayHealthState = "up_to_date" | "stale" | "refreshing" | "failed" | "never_refreshed";

function displayHealthState(health: SourceHealthSummary | undefined, refreshing: boolean): DisplayHealthState {
  if (refreshing) return "refreshing";
  if (!health || health.lastStatus === "never_run") return "never_refreshed";
  if (health.lastStatus === "failed") return "failed";
  // lastStatus === "success"
  if (health.lastSucceededAt && Date.now() - health.lastSucceededAt.getTime() <= FRESHNESS_THRESHOLD_MS) {
    return "up_to_date";
  }
  return "stale";
}

const HEALTH_STATE_LABEL: Record<DisplayHealthState, string> = {
  up_to_date: "Up to date",
  stale: "Stale",
  refreshing: "Refreshing",
  failed: "Failed",
  never_refreshed: "Never refreshed",
};

const HEALTH_STATE_DOT_CLASS: Record<DisplayHealthState, string> = {
  up_to_date: "bg-emerald-400",
  stale: "bg-amber-400",
  refreshing: "bg-blue-400 animate-pulse",
  failed: "bg-red-400",
  never_refreshed: "bg-slate-500",
};

function NavSection({
  title,
  items,
  activeLabel,
  onItemClick,
  badges,
}: {
  title?: string;
  items: NavItem[];
  activeLabel?: string;
  onItemClick?: (label: string) => void;
  /** Step 26: an optional small count pill after a nav item's label — only
   * "Queue" uses this today (unread queued count), cheap because it's
   * sourced from one bounded query already run for this render (see
   * page.tsx), never polled. */
  badges?: Record<string, number>;
}) {
  return (
    <div className="mb-6">
      {title && (
        <h3 className="px-3 mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          {title}
        </h3>
      )}
      <ul className="space-y-0.5">
        {items.map(({ label, icon: Icon, href }) => {
          const isActive = label === activeLabel;
          const badgeCount = badges?.[label];
          const className = `flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
            isActive ? "bg-white/10 text-white font-medium" : "text-slate-300 hover:bg-white/5 hover:text-white"
          }`;
          const content = (
            <>
              <Icon size={17} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">{label}</span>
              {Boolean(badgeCount) && (
                <span className="shrink-0 rounded-full bg-blue-500/90 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                  {badgeCount}
                </span>
              )}
            </>
          );
          return (
            <li key={label}>
              {href ? (
                <Link href={href} aria-current={isActive ? "page" : undefined} className={className}>
                  {content}
                </Link>
              ) : (
                <button
                  type="button"
                  aria-current={isActive ? "page" : undefined}
                  onClick={onItemClick ? () => onItemClick(label) : undefined}
                  className={className}
                >
                  {content}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SourceHealthSection({
  sourceHealth,
  refreshing,
  refreshMessage,
  onRefresh,
}: {
  sourceHealth: SourceHealthSummary[];
  refreshing: boolean;
  refreshMessage: string | null;
  onRefresh: () => void;
}) {
  const healthByKey = new Map(sourceHealth.map((h) => [h.sourceKey, h]));
  // Fixed display order/labels independent of DB row order, and using the
  // actual configured source set rather than a second hardcoded list of
  // source names — RSS publishers are read straight out of `sourceHealth`
  // itself (already keyed `rss:<id>` by refreshService.ts) so a newly
  // configured feed shows up here with no code change in this component.
  const primaryKeys = ["hackernews", "arxiv", "github"];
  const rssKeys = sourceHealth.map((h) => h.sourceKey).filter((key) => key.startsWith("rss:")).sort();
  const orderedKeys = [...primaryKeys, ...rssKeys];

  return (
    <div className="mb-6">
      <div className="mb-2 flex items-center justify-between px-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Source health</h3>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-busy={refreshing}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-slate-300 transition-colors hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
          {refreshing ? "Refreshing…" : "Refresh sources"}
        </button>
      </div>

      <ul className="space-y-1.5 px-3">
        {orderedKeys.map((key) => {
          const health = healthByKey.get(key);
          const label = health?.sourceLabel ?? key;
          const state = displayHealthState(health, refreshing);
          const lastSuccess = health?.lastSucceededAt
            ? formatRelativeTime(health.lastSucceededAt.toISOString())
            : null;
          return (
            <li key={key} className="flex items-center justify-between gap-2 text-xs">
              <span className="flex min-w-0 items-center gap-2 text-slate-300">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${HEALTH_STATE_DOT_CLASS[state]}`} aria-hidden="true" />
                <span className="truncate">{label}</span>
              </span>
              <span className="shrink-0 text-right text-slate-500">
                {state === "never_refreshed" ? HEALTH_STATE_LABEL[state] : lastSuccess ?? HEALTH_STATE_LABEL[state]}
                {health?.lastSuccessItemCount != null && state !== "never_refreshed" ? ` · ${health.lastSuccessItemCount}` : ""}
              </span>
            </li>
          );
        })}
      </ul>

      {refreshMessage && (
        <p className="mt-2 px-3 text-xs text-slate-400" role="status">
          {refreshMessage}
        </p>
      )}
    </div>
  );
}

interface SidebarProps {
  className?: string;
  /** Nav label currently matching the active feed tab, so the sidebar
   * highlight and the tab bar never disagree. */
  activeNavLabel?: string;
  /** Step 29: every non-href nav item (Home, Papers (arXiv), GitHub
   * Repositories, Hacker News, Discussions, Bookmarks) maps to a real
   * FeedFilters tab via this callback — see `handleSidebarNavClick` in
   * DashboardClient.tsx. */
  onNavItemClick?: (label: string) => void;
  /** Step 21: current per-source health, rendered only when the caller
   * supplies it — pages that embed Sidebar without wiring refresh (none
   * today, but kept optional for resilience) simply skip this section. */
  sourceHealth?: SourceHealthSummary[];
  refreshing?: boolean;
  refreshMessage?: string | null;
  onRefreshSources?: () => void;
  /** Step 26 §7: queued-but-unread count for the "Queue" nav badge. Omitted
   * (no badge shown) unless the caller already has it cheaply from one
   * bounded query — never fetched here, never polled. */
  unreadQueuedCount?: number;
}

export function Sidebar({
  className = "",
  activeNavLabel,
  onNavItemClick,
  sourceHealth,
  refreshing = false,
  refreshMessage = null,
  onRefreshSources,
  unreadQueuedCount,
}: SidebarProps) {
  return (
    <aside
      className={`flex h-full w-64 flex-col bg-slate-900 text-slate-200 ${className}`}
      aria-label="Main navigation"
    >
      <Link href="/" className="flex items-center gap-2 px-5 py-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600">
          <Sparkles size={18} className="text-white" />
        </span>
        <div className="leading-tight">
          <p className="text-base font-semibold text-white">AI News Hub</p>
          <p className="text-[11px] text-slate-400">Curated. Summarized. Stay Ahead.</p>
        </div>
      </Link>

      <nav className="flex-1 overflow-y-auto px-3 pb-6">
        <NavSection
          items={navItems}
          activeLabel={activeNavLabel}
          onItemClick={onNavItemClick}
          badges={unreadQueuedCount ? { Queue: unreadQueuedCount } : undefined}
        />
        {sourceHealth && onRefreshSources && (
          <SourceHealthSection
            sourceHealth={sourceHealth}
            refreshing={refreshing}
            refreshMessage={refreshMessage}
            onRefresh={onRefreshSources}
          />
        )}
      </nav>
    </aside>
  );
}
