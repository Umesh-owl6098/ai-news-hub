import Link from "next/link";
import { Sparkles } from "lucide-react";
import { getQueueItems } from "@/db/repository";
import { BackButton } from "@/components/BackButton";
import { QueueList, type QueueStatus } from "@/components/QueueList";

const STATUS_VALUES: readonly QueueStatus[] = ["all", "unread", "read"];
const DEFAULT_STATUS: QueueStatus = "all";

function isQueueStatus(value: string): value is QueueStatus {
  return (STATUS_VALUES as readonly string[]).includes(value);
}

function parseStatus(raw: string | string[] | undefined): QueueStatus {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && isQueueStatus(value) ? value : DEFAULT_STATUS;
}

/**
 * Step 26 — the reading queue: a practical, compact reading list, not
 * another dashboard. Database reads only (`getQueueItems`, one bounded
 * joined query — no per-row lookups): no OpenAI call, no embedding call,
 * no source-network call, and — critically — no mutation from viewing
 * this page or switching the All/Unread/Read filter. Every state change
 * comes from an explicit click on a row's own control; `QueueList` (a
 * client component) keeps the filtered rows and counts in sync with
 * those *persisted* changes without a reload (see its own doc comment).
 *
 * Ordering is the user's own explicit queue action (most-recently-queued
 * first, via `queuedAt` — see repository.ts), never editorial ranking.
 */
export default async function QueuePage({ searchParams }: PageProps<"/queue">) {
  const params = await searchParams;
  const status = parseStatus(params.status);

  const queueItems = await getQueueItems();

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-3 sm:px-6">
          <BackButton />
          <span aria-hidden="true" className="text-slate-300">
            |
          </span>
          <Link
            href="/"
            className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm font-semibold text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-blue-500 to-purple-600">
              <Sparkles size={13} className="text-white" />
            </span>
            AI News Hub
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <h1 className="text-2xl font-bold text-slate-900">Reading queue</h1>
        <p className="mt-1 text-sm text-slate-500">
          Items you&apos;ve set aside to read later, most recently queued first.
        </p>

        <QueueList items={queueItems} status={status} />
      </main>
    </div>
  );
}
