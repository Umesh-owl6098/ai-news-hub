"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Menu, X, RotateCw, AlertTriangle, Info } from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { SearchBar } from "@/components/SearchBar";
import { FeedFilters, FilterValue, type PublisherOption } from "@/components/FeedFilters";
import { SearchControls } from "@/components/SearchControls";
import { FeedCard } from "@/components/FeedCard";
import { RightSidebar } from "@/components/RightSidebar";
import { FeedItem, SourceType } from "@/types/feed";
import { dedupeFeedItems } from "@/lib/dedupe";
import { addBookmarkAction, removeBookmarkAction } from "@/app/actions/bookmarks";
import { addToQueueAction, removeFromQueueAction } from "@/app/actions/readingState";
import { refreshSourcesAction } from "@/app/actions/refresh";
import type { SourceHealthSummary } from "@/db/repository";
import {
  applySearchStateUpdate,
  buildSearchQueryString,
  isSearchActive,
  type SearchState,
  type SearchMode,
  type TimeRange,
} from "@/lib/searchState";

const filterToSourceType: Partial<Record<FilterValue, SourceType>> = {
  Discussions: "discussion",
};

// Step 29: the sidebar's nav labels for tab-mapped items don't all match
// FeedFilters' own FilterValue strings verbatim (e.g. "Papers (arXiv)" vs
// "Papers"), so this is the one explicit translation table both the click
// handler and the active-label highlight use — never two competing maps.
const SIDEBAR_LABEL_TO_TAB: Record<string, FilterValue> = {
  Home: "All",
  "Papers (arXiv)": "Papers",
  "GitHub Repositories": "GitHub",
  "Hacker News": "Hacker News",
  Discussions: "Discussions",
  Bookmarks: "Bookmarks",
};

const TAB_TO_SIDEBAR_LABEL: Partial<Record<FilterValue, string>> = Object.fromEntries(
  Object.entries(SIDEBAR_LABEL_TO_TAB).map(([label, tab]) => [tab, label])
);

// How many live items from each real source to blend into the "All" tab
// alongside the mock items from sources that aren't live yet.
const HN_ITEMS_IN_ALL_TAB = 3;
const ARXIV_ITEMS_IN_ALL_TAB = 3;
const GITHUB_ITEMS_IN_ALL_TAB = 3;
const NEWS_ITEMS_IN_ALL_TAB = 3;

const RECENT_BOOKMARKS_IN_SIDEBAR = 3;
const BOOKMARK_ERROR_DISPLAY_MS = 5000;

function publishedAtMs(item: FeedItem): number {
  const time = new Date(item.publishedAt).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function sortItems(items: FeedItem[], sort: string): FeedItem[] {
  if (sort === "top") return [...items].sort((a, b) => b.score - a.score);
  if (sort === "discussed") return [...items].sort((a, b) => b.commentCount - a.commentCount);
  // "latest" — publishedAt is an ISO timestamp, so this is a real chronological sort.
  return [...items].sort((a, b) => publishedAtMs(b) - publishedAtMs(a));
}

function FeedCardSkeleton() {
  return (
    <div className="animate-pulse rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 h-4 w-24 rounded bg-slate-200" />
      <div className="mb-2 h-4 w-3/4 rounded bg-slate-200" />
      <div className="mb-3 h-3 w-full rounded bg-slate-100" />
      <div className="flex gap-2">
        <div className="h-5 w-16 rounded-full bg-slate-100" />
        <div className="h-5 w-16 rounded-full bg-slate-100" />
      </div>
    </div>
  );
}

interface LiveTabState {
  items: FeedItem[];
  error: string | null;
  emptyMessage: string;
  notice?: string | null;
}

interface DashboardClientProps {
  mockItems: FeedItem[];
  hnItems: FeedItem[];
  hnError: string | null;
  hnNotice: string | null;
  arxivItems: FeedItem[];
  arxivError: string | null;
  arxivNotice: string | null;
  githubItems: FeedItem[];
  githubError: string | null;
  githubNotice: string | null;
  newsItems: FeedItem[];
  newsError: string | null;
  newsNotice: string | null;
  initialBookmarkedKeys: string[];
  initialBookmarkedItems: FeedItem[];
  bookmarksError: string | null;
  /** Step 26: currently-queued source keys, for FeedCard's compact queue
   * toggle — same lifted-state shape as bookmarks, since FeedCard renders
   * its own controls from props/callbacks rather than a self-contained
   * component (see FeedCard.tsx). */
  initialQueuedKeys: string[];
  /** Queued-but-unread count for the Sidebar's "Queue" nav badge — read
   * once per render, never polled (§7). */
  unreadQueuedCount: number;
  /** Parsed, validated, bounded URL state — see lib/searchState.ts. */
  searchState: SearchState;
  /** Publisher options for the News tab's dropdown, from real config. */
  publisherOptions: PublisherOption[];
  /** Present only when `isSearchActive(searchState)` — database search
   * results, or a clear error if persisted search couldn't run. */
  searchItems: FeedItem[];
  searchTotal: number;
  searchError: string | null;
  /** What the request asked for vs. what actually ran — differ only when a
   * Semantic request fell back to Keyword for this render (see lib/search.ts). */
  searchRequestedMode: SearchMode;
  searchEffectiveMode: SearchMode;
  /** Server-side capability check: is an embedding provider configured at
   * all, independent of whether this particular request used it. Drives
   * whether Semantic is offered as a choice before a search even runs. */
  semanticAvailable: boolean;
  /** AI enrichment (summary + topic chips), keyed by FeedItem.id, for every
   * item across every source/tab this render fetched — one bulk lookup
   * built server-side (see page.tsx), never a per-card query. An item with
   * no entry here has no enrichment yet and renders exactly as before. */
  enrichments: Record<string, { summary: string; topics: string[] }>;
  /** Step 21: current per-source ingestion health, read fresh on every
   * render (a plain DB read, never a live source call) — drives the
   * Sidebar's source-status panel and "Refresh sources" control. */
  sourceHealth: SourceHealthSummary[];
}

export function DashboardClient({
  mockItems,
  hnItems,
  hnError,
  hnNotice,
  arxivItems,
  arxivError,
  arxivNotice,
  githubItems,
  githubError,
  githubNotice,
  newsItems,
  newsError,
  newsNotice,
  initialBookmarkedKeys,
  initialBookmarkedItems,
  bookmarksError,
  initialQueuedKeys,
  unreadQueuedCount,
  searchState,
  publisherOptions,
  searchItems,
  searchTotal,
  searchError,
  searchRequestedMode,
  searchEffectiveMode,
  semanticAvailable,
  enrichments,
  sourceHealth,
}: DashboardClientProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mobileNavOpenButtonRef = useRef<HTMLButtonElement>(null);
  const mobileNavCloseButtonRef = useRef<HTMLButtonElement>(null);
  const mobileNavWasOpenRef = useRef(false);

  // Step 29 audit finding: the mobile nav drawer had no keyboard/screen-
  // reader affordances beyond a visible "Close navigation" button — no
  // Escape-to-close, no dialog semantics, and focus neither moved into the
  // drawer on open nor back to the trigger on close. A keyboard user could
  // open it but had to Tab all the way through every nav item to reach the
  // close button, and a screen reader never announced it as a dialog at all.
  useEffect(() => {
    if (mobileNavOpen) {
      mobileNavWasOpenRef.current = true;
      mobileNavCloseButtonRef.current?.focus();
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") setMobileNavOpen(false);
      };
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }
    // Only return focus to the trigger when the drawer was actually open
    // and just closed — never on initial mount, when it was never open.
    if (mobileNavWasOpenRef.current) {
      mobileNavWasOpenRef.current = false;
      mobileNavOpenButtonRef.current?.focus();
    }
  }, [mobileNavOpen]);
  const [isNavigating, startNavigate] = useTransition();
  const [isRetrying, startRetry] = useTransition();
  const router = useRouter();
  const pathname = usePathname();

  // Step 21: refresh is a request-scoped UI concern, not persisted state —
  // `refreshing`/`refreshMessage` only ever describe THIS tab's own
  // in-flight request. The server-side guard in refreshService.ts (not
  // this flag) is what actually prevents two overlapping refreshes from
  // corrupting anything; this just prevents this tab's own button from
  // firing a second request while one is already in flight.
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);

  const handleRefreshSources = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshMessage(null);
    try {
      const result = await refreshSourcesAction();
      if (result.ok && result.summary) {
        const succeeded = result.summary.outcomes.filter((o) => o.status === "success").length;
        const failed = result.summary.outcomes.filter((o) => o.status === "failed").length;
        setRefreshMessage(
          failed === 0
            ? `Refreshed — ${succeeded} source${succeeded === 1 ? "" : "s"} updated.`
            : `${succeeded} succeeded, ${failed} failed — see status below.`
        );
        // Re-runs page.tsx's Server Component with fresh persisted data
        // (feed items AND source health) — the one place a refresh's
        // results actually reach the visible feed.
        router.refresh();
      } else {
        setRefreshMessage(result.error ?? "Couldn't refresh sources. Try again.");
      }
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, router]);

  const filter = searchState.tab;
  const sort = searchState.sort;
  const searching = isSearchActive(searchState);

  const navigate = useCallback(
    (partial: Partial<SearchState>) => {
      const next = applySearchStateUpdate(searchState, partial);
      const qs = buildSearchQueryString(next);
      startNavigate(() => {
        router.push(`${pathname}${qs}`, { scroll: false });
      });
    },
    [searchState, router, pathname]
  );

  // PostgreSQL is the durable source of truth (Step 7). This client state
  // exists only for immediate, optimistic interaction — it is seeded from
  // the server on load and reconciled with the server's response after
  // every add/remove, never treated as truth on its own.
  const [bookmarkedKeys, setBookmarkedKeys] = useState<Set<string>>(() => new Set(initialBookmarkedKeys));
  // Most-recently-bookmarked first. Seeded in DB order; toggling during the
  // session updates this directly so the Bookmarks tab never needs a
  // server round-trip to reflect a just-added/removed bookmark.
  const [bookmarkOrder, setBookmarkOrder] = useState<string[]>(initialBookmarkedKeys);
  // Keys with an add/remove request currently in flight — disables that
  // card's control so a double-click can't fire a duplicate request.
  const [pendingBookmarkKeys, setPendingBookmarkKeys] = useState<Set<string>>(new Set());
  const [bookmarkErrorMessage, setBookmarkErrorMessage] = useState<string | null>(null);
  const bookmarkErrorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (bookmarkErrorTimeoutRef.current) clearTimeout(bookmarkErrorTimeoutRef.current);
    };
  }, []);

  const showBookmarkError = useCallback((message: string) => {
    setBookmarkErrorMessage(message);
    if (bookmarkErrorTimeoutRef.current) clearTimeout(bookmarkErrorTimeoutRef.current);
    bookmarkErrorTimeoutRef.current = setTimeout(() => setBookmarkErrorMessage(null), BOOKMARK_ERROR_DISPLAY_MS);
  }, []);

  // Every item currently known to the client, from any source (including
  // this render's search results) — lets the Bookmarks tab render full
  // metadata for an item bookmarked just now, from wherever it came from.
  const allItemsById = useMemo(() => {
    const map = new Map<string, FeedItem>();
    for (const item of [
      ...initialBookmarkedItems,
      ...mockItems,
      ...hnItems,
      ...arxivItems,
      ...githubItems,
      ...newsItems,
      ...searchItems,
    ]) {
      map.set(item.id, item);
    }
    return map;
  }, [initialBookmarkedItems, mockItems, hnItems, arxivItems, githubItems, newsItems, searchItems]);

  const toggleBookmark = useCallback(
    (item: FeedItem) => {
      if (pendingBookmarkKeys.has(item.id)) return; // ignore double-click while a request is in flight

      const wasBookmarked = bookmarkedKeys.has(item.id);

      // 1. Update UI immediately.
      setBookmarkedKeys((prev) => {
        const next = new Set(prev);
        if (wasBookmarked) next.delete(item.id);
        else next.add(item.id);
        return next;
      });
      setBookmarkOrder((prev) =>
        wasBookmarked ? prev.filter((key) => key !== item.id) : [item.id, ...prev.filter((key) => key !== item.id)]
      );
      setPendingBookmarkKeys((prev) => new Set(prev).add(item.id));

      // 2. Persist on the server.
      const action = wasBookmarked ? removeBookmarkAction : addBookmarkAction;
      action(item.id)
        .then((result) => {
          if (!result.ok) {
            // 4. Persistence failed — restore previous state and surface a subtle error.
            setBookmarkedKeys((prev) => {
              const next = new Set(prev);
              if (wasBookmarked) next.add(item.id);
              else next.delete(item.id);
              return next;
            });
            setBookmarkOrder((prev) =>
              wasBookmarked ? [item.id, ...prev.filter((key) => key !== item.id)] : prev.filter((key) => key !== item.id)
            );
            showBookmarkError(result.error ?? "Couldn't save bookmark. Try again.");
          }
          // 3. Success — optimistic state already matches the server; nothing else to do.
        })
        .catch(() => {
          setBookmarkedKeys((prev) => {
            const next = new Set(prev);
            if (wasBookmarked) next.add(item.id);
            else next.delete(item.id);
            return next;
          });
          setBookmarkOrder((prev) =>
            wasBookmarked ? [item.id, ...prev.filter((key) => key !== item.id)] : prev.filter((key) => key !== item.id)
          );
          showBookmarkError("Couldn't save bookmark. Try again.");
        })
        .finally(() => {
          setPendingBookmarkKeys((prev) => {
            const next = new Set(prev);
            next.delete(item.id);
            return next;
          });
        });
    },
    [bookmarkedKeys, pendingBookmarkKeys, showBookmarkError]
  );

  // Step 26: same optimistic add/remove pattern as bookmarks, independent
  // state — queuing/unqueuing an item never touches bookmarkedKeys and
  // vice versa. No ordering to track here (unlike bookmarks' sidebar
  // preview): /queue is server-rendered from persisted queuedAt directly.
  const [queuedKeys, setQueuedKeys] = useState<Set<string>>(() => new Set(initialQueuedKeys));
  const [pendingQueueKeys, setPendingQueueKeys] = useState<Set<string>>(new Set());
  const [queueErrorMessage, setQueueErrorMessage] = useState<string | null>(null);
  const queueErrorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (queueErrorTimeoutRef.current) clearTimeout(queueErrorTimeoutRef.current);
    };
  }, []);

  const showQueueError = useCallback((message: string) => {
    setQueueErrorMessage(message);
    if (queueErrorTimeoutRef.current) clearTimeout(queueErrorTimeoutRef.current);
    queueErrorTimeoutRef.current = setTimeout(() => setQueueErrorMessage(null), BOOKMARK_ERROR_DISPLAY_MS);
  }, []);

  const toggleQueue = useCallback(
    (item: FeedItem) => {
      if (pendingQueueKeys.has(item.id)) return;

      const wasQueued = queuedKeys.has(item.id);

      setQueuedKeys((prev) => {
        const next = new Set(prev);
        if (wasQueued) next.delete(item.id);
        else next.add(item.id);
        return next;
      });
      setPendingQueueKeys((prev) => new Set(prev).add(item.id));

      const action = wasQueued ? removeFromQueueAction : addToQueueAction;
      action(item.id)
        .then((result) => {
          if (!result.ok) {
            setQueuedKeys((prev) => {
              const next = new Set(prev);
              if (wasQueued) next.add(item.id);
              else next.delete(item.id);
              return next;
            });
            showQueueError(result.error ?? "Couldn't update the reading queue. Try again.");
          }
        })
        .catch(() => {
          setQueuedKeys((prev) => {
            const next = new Set(prev);
            if (wasQueued) next.add(item.id);
            else next.delete(item.id);
            return next;
          });
          showQueueError("Couldn't update the reading queue. Try again.");
        })
        .finally(() => {
          setPendingQueueKeys((prev) => {
            const next = new Set(prev);
            next.delete(item.id);
            return next;
          });
        });
    },
    [queuedKeys, pendingQueueKeys, showQueueError]
  );

  const recentBookmarkItems = useMemo(
    () =>
      bookmarkOrder
        .slice(0, RECENT_BOOKMARKS_IN_SIDEBAR)
        .map((key) => allItemsById.get(key))
        .filter((item): item is FeedItem => Boolean(item)),
    [bookmarkOrder, allItemsById]
  );

  const allTabItems = useMemo(
    () => [
      ...mockItems,
      ...hnItems.slice(0, HN_ITEMS_IN_ALL_TAB),
      ...arxivItems.slice(0, ARXIV_ITEMS_IN_ALL_TAB),
      ...githubItems.slice(0, GITHUB_ITEMS_IN_ALL_TAB),
      ...newsItems.slice(0, NEWS_ITEMS_IN_ALL_TAB),
    ],
    [mockItems, hnItems, arxivItems, githubItems, newsItems]
  );

  const bookmarksTabItems = useMemo(
    () => bookmarkOrder.map((key) => allItemsById.get(key)).filter((item): item is FeedItem => Boolean(item)),
    [bookmarkOrder, allItemsById]
  );

  const liveTabState: LiveTabState | null = useMemo(() => {
    if (filter === "Hacker News") {
      return {
        items: hnItems,
        error: hnError,
        emptyMessage: "No AI-related Hacker News stories found right now.",
        notice: hnNotice,
      };
    }
    if (filter === "Papers") {
      return {
        items: arxivItems,
        error: arxivError,
        emptyMessage: "No recent AI papers found.",
        notice: arxivNotice,
      };
    }
    if (filter === "GitHub") {
      return {
        items: githubItems,
        error: githubError,
        emptyMessage: "No AI repositories found right now.",
        notice: githubNotice,
      };
    }
    if (filter === "News") {
      return { items: newsItems, error: newsError, emptyMessage: "No recent AI news found.", notice: newsNotice };
    }
    if (filter === "Bookmarks") {
      return {
        items: bookmarksTabItems,
        error: bookmarksError,
        emptyMessage: "No bookmarks yet — save something from any tab.",
        notice: null,
      };
    }
    return null;
  }, [
    filter,
    hnItems,
    hnError,
    hnNotice,
    arxivItems,
    arxivError,
    arxivNotice,
    githubItems,
    githubError,
    githubNotice,
    newsItems,
    newsError,
    newsNotice,
    bookmarksTabItems,
    bookmarksError,
  ]);

  // Search results already reflect bookmark membership from the server at
  // request time; while viewing the Bookmarks tab specifically, filter
  // through the live client bookmark set too, so unbookmarking an item
  // removes it from view immediately instead of waiting for a refresh.
  const displayedSearchItems = useMemo(() => {
    if (filter !== "Bookmarks") return searchItems;
    return searchItems.filter((item) => bookmarkedKeys.has(item.id));
  }, [searchItems, filter, bookmarkedKeys]);

  const displayedSearchTotal = filter === "Bookmarks" ? displayedSearchItems.length : searchTotal;

  const items = useMemo(() => {
    if (searching) return displayedSearchItems; // already ordered by the repository (relevance/newest)
    if (liveTabState) return sortItems(liveTabState.items, sort);
    // Only the combined "All" feed needs cross-source dedup — dedicated
    // tabs (Hacker News, etc.) always show their own untouched items.
    if (filter === "All") return sortItems(dedupeFeedItems(allTabItems), sort);

    const targetType = filterToSourceType[filter];
    const filtered = targetType ? mockItems.filter((item) => item.sourceType === targetType) : mockItems;
    return sortItems(filtered, sort);
  }, [searching, displayedSearchItems, filter, sort, liveTabState, allTabItems, mockItems]);

  const handleRetry = () => {
    startRetry(() => {
      router.refresh();
    });
  };

  const handleTabChange = (tab: FilterValue) => {
    // `source` (publisher) only means something on the News tab — clear it
    // when leaving, so switching tabs can never leave an invisible filter
    // silently constraining results (Step 8 §11: make impossible states impossible).
    navigate({ tab, source: tab === "News" ? searchState.source : undefined });
  };

  const handleSidebarNavClick = (label: string) => {
    const tab = SIDEBAR_LABEL_TO_TAB[label];
    if (tab) handleTabChange(tab);
  };

  // Step 29: every sidebar nav label that maps to a FeedFilters tab must
  // highlight correctly for every tab it can land on, not just Home/
  // Bookmarks — otherwise the sidebar silently disagrees with the tab bar
  // the moment a newly-wired item (Papers, GitHub, etc.) is actually used.
  // Deliberately undefined (no highlight) rather than defaulting to "Home"
  // when on a tab with no sidebar item at all (News) — a false "Home"
  // highlight would be more misleading than none.
  const sidebarActiveLabel = TAB_TO_SIDEBAR_LABEL[filter];

  const showSkeletons = (liveTabState && isRetrying) || isNavigating;
  const currentError = searching ? searchError : liveTabState?.error ?? null;
  const showError = !isNavigating && Boolean(currentError);
  const showEmpty =
    !isNavigating &&
    !currentError &&
    (searching ? displayedSearchItems.length === 0 : liveTabState ? liveTabState.items.length === 0 : false);
  const showItems = !isNavigating && !currentError;
  const showNotice = !searching && liveTabState && !isRetrying && !liveTabState.error && liveTabState.notice;
  // Semantic was requested but this request actually ran as Keyword (no
  // provider configured, or a transient embedding/provider failure) — never
  // pretend the rendered items are semantic results (Step 18 §3).
  const showSemanticFallbackNotice =
    searching && !isNavigating && !currentError && searchRequestedMode === "semantic" && searchEffectiveMode === "keyword";

  const emptyMessage = searching
    ? searchState.q
      ? `No results for "${searchState.q}". Try a broader search or clear some filters.`
      : "No results match these filters."
    : liveTabState?.emptyMessage ?? "No items match this filter yet.";

  return (
    <div className="flex min-h-screen w-full bg-slate-50">
      {/* Desktop: pinned to the viewport while the page scrolls. `self-start`
          stops flex's default stretch from making the sidebar as tall as the
          whole document (which left nothing for `sticky` to move within);
          `lg:h-screen` bounds it to the viewport so the nav's own
          overflow-y-auto scrolls internally on short screens. */}
      <Sidebar
        className="hidden lg:sticky lg:top-0 lg:flex lg:h-screen lg:self-start"
        activeNavLabel={sidebarActiveLabel}
        onNavItemClick={handleSidebarNavClick}
        sourceHealth={sourceHealth}
        refreshing={refreshing}
        refreshMessage={refreshMessage}
        onRefreshSources={handleRefreshSources}
        unreadQueuedCount={unreadQueuedCount}
      />

      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation menu">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden="true"
          />
          <Sidebar
            className="relative z-50 flex"
            activeNavLabel={sidebarActiveLabel}
            onNavItemClick={(label) => {
              handleSidebarNavClick(label);
              setMobileNavOpen(false);
            }}
            sourceHealth={sourceHealth}
            refreshing={refreshing}
            refreshMessage={refreshMessage}
            onRefreshSources={handleRefreshSources}
            unreadQueuedCount={unreadQueuedCount}
          />
          <button
            ref={mobileNavCloseButtonRef}
            type="button"
            aria-label="Close navigation"
            onClick={() => setMobileNavOpen(false)}
            className="absolute right-3 top-4 z-50 rounded-md p-2 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <X size={20} />
          </button>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur sm:px-6">
          <button
            ref={mobileNavOpenButtonRef}
            type="button"
            aria-label="Open navigation"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen(true)}
            className="rounded-md p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
          >
            <Menu size={20} />
          </button>
          <SearchBar query={searchState.q} onQueryChange={(q) => navigate({ q })} />
        </header>

        <div className="flex flex-1 flex-col gap-6 px-4 py-6 sm:px-6 xl:flex-row">
          <main className="flex min-w-0 flex-1 flex-col gap-4">
            <FeedFilters
              active={filter}
              onChange={handleTabChange}
              sort={sort}
              onSortChange={(nextSort) => navigate({ sort: nextSort })}
              searching={searching}
              publisherOptions={filter === "News" ? publisherOptions : []}
              selectedSource={searchState.source}
              onSourceChange={(source) => navigate({ source })}
            />

            {searching && (
              <SearchControls
                state={searchState}
                total={displayedSearchTotal}
                semanticAvailable={semanticAvailable}
                effectiveMode={searchEffectiveMode}
                onTimeChange={(time: TimeRange) => navigate({ time })}
                onModeChange={(mode) => navigate({ mode })}
                onClearFilters={() => navigate({ time: "any", source: undefined })}
                onClearSearch={() => navigate({ q: "" })}
                onPageChange={(page) => navigate({ page })}
              />
            )}

            <div className="flex flex-col gap-3">
              {bookmarkErrorMessage && (
                <div
                  role="alert"
                  className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700"
                >
                  <AlertTriangle size={14} />
                  {bookmarkErrorMessage}
                </div>
              )}

              {queueErrorMessage && (
                <div
                  role="alert"
                  className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700"
                >
                  <AlertTriangle size={14} />
                  {queueErrorMessage}
                </div>
              )}

              {showNotice && (
                <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
                  <Info size={14} />
                  {liveTabState.notice}
                </div>
              )}

              {showSemanticFallbackNotice && (
                <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
                  <Info size={14} />
                  Semantic search unavailable — showing keyword results.
                </div>
              )}

              {showSkeletons &&
                Array.from({ length: 4 }).map((_, i) => <FeedCardSkeleton key={i} />)}

              {showError && (
                <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-red-200 bg-red-50 p-8 text-center">
                  <AlertTriangle className="text-red-500" size={22} />
                  <p className="text-sm font-medium text-red-700">{currentError}</p>
                  {!searching && (
                    <button
                      type="button"
                      onClick={handleRetry}
                      className="flex items-center gap-2 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
                    >
                      <RotateCw size={14} />
                      Retry
                    </button>
                  )}
                </div>
              )}

              {!showSkeletons && !showError && showEmpty && (
                <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
                  {emptyMessage}
                </p>
              )}

              {!showSkeletons &&
                showItems &&
                !showEmpty &&
                items.map((item) => (
                  <FeedCard
                    key={item.id}
                    item={item}
                    bookmarked={bookmarkedKeys.has(item.id)}
                    bookmarkPending={pendingBookmarkKeys.has(item.id)}
                    onToggleBookmark={toggleBookmark}
                    queued={queuedKeys.has(item.id)}
                    queuePending={pendingQueueKeys.has(item.id)}
                    onToggleQueue={toggleQueue}
                    enrichment={enrichments[item.id] ?? null}
                  />
                ))}
            </div>
          </main>

          <RightSidebar className="xl:w-80 xl:shrink-0" recentBookmarks={recentBookmarkItems} />
        </div>
      </div>
    </div>
  );
}
