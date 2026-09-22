import Link from "next/link";
import { Sparkles } from "lucide-react";

export default function TopicNotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50 px-4 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600">
        <Sparkles size={20} className="text-white" />
      </span>
      <h1 className="text-lg font-semibold text-slate-900">This topic isn&apos;t available</h1>
      <p className="max-w-sm text-sm text-slate-500">
        It doesn&apos;t match any currently-tagged content, even over the widest window.
      </p>
      <Link
        href="/topics"
        className="mt-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        Browse all topics
      </Link>
    </div>
  );
}
