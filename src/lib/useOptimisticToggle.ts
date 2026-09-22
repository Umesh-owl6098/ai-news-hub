"use client";

import { useEffect, useRef, useState } from "react";

export interface ToggleActionResult {
  ok: boolean;
  error?: string;
}

/**
 * The optimistic add/remove-request pattern shared by every boolean
 * persisted-state toggle in this app (bookmark, queue, read) — update the
 * UI immediately, persist in the background, and roll back with a visible
 * error if persistence fails. Each call owns its own item's state, so this
 * is safe to use from many independent card-level instances at once (no
 * shared/lifted state needed) — see BookmarkButton for the original,
 * pre-extraction version of this logic.
 *
 * Step 29 audit finding: `initialValue` used to seed `useState` only once,
 * at mount. That's correct for a normal page load, but Next's App Router
 * can reuse an already-mounted instance of a component like this one when
 * the user navigates to an item's detail page and back — React preserves
 * the component instance, so its `useState` initializer never re-runs,
 * even though the server re-sent a fresh (and possibly different)
 * `initialValue` for that same instance. Confirmed reproducible: bookmark
 * an item on /queue, open its detail (correctly shows "Bookmarked"), hit
 * Back, and the /queue row silently reverted to "not bookmarked" — a real
 * value the user had just set, contradicted by the UI a second later.
 * Re-syncing whenever `initialValue` itself changes (paired with
 * PopstateRefresh.tsx forcing a fresh server payload on back/forward)
 * fixes this without weakening the optimistic-update path for a direct
 * click, which still updates `value` immediately, before any prop change
 * could possibly arrive.
 */
export function useOptimisticToggle(initialValue: boolean, action: (next: boolean) => Promise<ToggleActionResult>) {
  const [value, setValue] = useState(initialValue);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previousInitialValue = useRef(initialValue);

  useEffect(() => {
    if (initialValue !== previousInitialValue.current) {
      previousInitialValue.current = initialValue;
      setValue(initialValue);
    }
  }, [initialValue]);

  const toggle = async (fallbackError: string) => {
    if (pending) return;
    const next = !value;
    setValue(next);
    setPending(true);
    setError(null);

    const result = await action(next);
    if (!result.ok) {
      setValue(!next);
      setError(result.error ?? fallbackError);
    }
    setPending(false);
  };

  return { value, pending, error, toggle };
}
