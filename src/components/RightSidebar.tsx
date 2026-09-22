import { Bookmark } from "lucide-react";
import { FeedItem } from "@/types/feed";

function Panel({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-800">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

interface RightSidebarProps {
  className?: string;
  /** Most-recently-bookmarked items first, already capped by the caller. */
  recentBookmarks: FeedItem[];
}

/**
 * Step 27 audit: this previously also rendered three additional panels —
 * a topic-chip list, a "today's stories" list, and a digest-frequency
 * toggle — all fixed mock data with no real behavior behind them (one
 * panel's list items linked to a literal `href="#"`, and its companion
 * button had no click handler at all). None of it was ever wired to
 * anything real, so removing it is not a functionality regression — it's
 * removing dead UI that added visual weight without adding capability.
 * `recentBookmarks` remains because it's the one panel here backed by
 * real, persisted state.
 */
export function RightSidebar({ className = "", recentBookmarks }: RightSidebarProps) {
  return (
    <aside className={`flex w-full flex-col gap-4 ${className}`} aria-label="Bookmarks panel">
      <Panel title="Recent Bookmarks" icon={<Bookmark size={15} className="text-blue-500" />}>
        {recentBookmarks.length > 0 ? (
          <ul className="space-y-2.5">
            {recentBookmarks.map((item) => (
              <li key={item.id} className="text-sm text-slate-600">
                <a href={item.url} target="_blank" rel="noreferrer noopener" className="hover:text-blue-600 hover:underline">
                  {item.title}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-400">Nothing bookmarked yet.</p>
        )}
      </Panel>
    </aside>
  );
}
