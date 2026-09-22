import Link from "next/link";
import { Sparkles } from "lucide-react";

export default function ItemNotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50 px-4 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600">
        <Sparkles size={20} className="text-white" />
      </span>
      <h1 className="text-lg font-semibold text-slate-900">This item isn&apos;t available</h1>
      <p className="max-w-sm text-sm text-slate-500">
        It may have been removed, or the link may be incorrect.
      </p>
      <Link
        href="/"
        className="mt-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        Back to AI News Hub
      </Link>
    </div>
  );
}
