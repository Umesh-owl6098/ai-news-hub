import { FileText, Code2, Flame, Newspaper, MessagesSquare, type LucideIcon } from "lucide-react";
import type { SourceType } from "@/types/feed";

/**
 * Per-sourceType icon/color used by both FeedCard (a "use client" component)
 * and the server-rendered `/item/[id]` detail page. Deliberately NOT
 * exported from FeedCard.tsx: React Server Components turn every export of
 * a "use client" module into an opaque client reference, so a plain data
 * object (not a component) imported from there into server code resolves
 * to `undefined` at the point of use — confirmed the hard way (a real
 * runtime "Cannot destructure property 'icon' of ... undefined" during
 * Step 19 QA). A plain, boundary-free module is the correct home.
 */
export const sourceMeta: Record<SourceType, { icon: LucideIcon; color: string }> = {
  news: { icon: Newspaper, color: "text-purple-600 bg-purple-50" },
  paper: { icon: FileText, color: "text-blue-600 bg-blue-50" },
  github: { icon: Code2, color: "text-slate-700 bg-slate-100" },
  hackernews: { icon: Flame, color: "text-orange-600 bg-orange-50" },
  discussion: { icon: MessagesSquare, color: "text-emerald-600 bg-emerald-50" },
};
