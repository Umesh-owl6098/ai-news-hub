"use client";

import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { MAX_QUERY_LENGTH } from "@/lib/searchState";

const DEBOUNCE_MS = 400;

interface SearchBarProps {
  /** Current query, from the URL (via the server) — not read with
   * useSearchParams, since the parent already has it as a prop. */
  query: string;
  onQueryChange: (query: string) => void;
}

export function SearchBar({ query, onQueryChange }: SearchBarProps) {
  const [value, setValue] = useState(query);
  // Adjust local state during render when the URL's query changes from
  // elsewhere (Clear button, browser back/forward, a filter reset) — the
  // documented React pattern for this, rather than an effect that would
  // cause an extra cascading render (react.dev/learn/you-might-not-need-an-effect).
  const [prevQuery, setPrevQuery] = useState(query);
  if (query !== prevQuery) {
    setPrevQuery(query);
    setValue(query);
  }

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const commit = (next: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    onQueryChange(next);
  };

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value.slice(0, MAX_QUERY_LENGTH);
    setValue(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Modest debounce — avoids a database query on every keystroke while
    // still feeling responsive; Enter (below) bypasses it entirely.
    debounceRef.current = setTimeout(() => onQueryChange(next), DEBOUNCE_MS);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit(value);
    }
  };

  const handleClear = () => {
    setValue("");
    commit("");
  };

  return (
    <div className="relative w-full max-w-xl">
      <Search
        size={18}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
      />
      <input
        type="search"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        aria-label="Search AI news, papers, repositories, or topics"
        placeholder="Search AI news, papers, repositories, or topics..."
        className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-10 pr-9 text-sm text-slate-700 placeholder:text-slate-400 shadow-sm outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={handleClear}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-400 transition-colors hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}
