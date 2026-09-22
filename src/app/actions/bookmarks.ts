"use server";

import { addBookmark, removeBookmark, DatabaseError } from "@/db/repository";
import { validateSourceKey } from "@/lib/sourceKey";

export interface BookmarkActionResult {
  ok: boolean;
  error?: string;
}

export async function addBookmarkAction(sourceKey: unknown): Promise<BookmarkActionResult> {
  const validated = validateSourceKey(sourceKey);
  if (!validated) return { ok: false, error: "Couldn't save bookmark. Try again." };

  try {
    await addBookmark(validated);
    return { ok: true };
  } catch (error) {
    // DatabaseError messages are already safe to show; anything else is
    // collapsed to a generic message so no internal detail reaches the client.
    const message = error instanceof DatabaseError ? error.message : "Couldn't save bookmark. Try again.";
    return { ok: false, error: message };
  }
}

export async function removeBookmarkAction(sourceKey: unknown): Promise<BookmarkActionResult> {
  const validated = validateSourceKey(sourceKey);
  if (!validated) return { ok: false, error: "Couldn't remove bookmark. Try again." };

  try {
    await removeBookmark(validated);
    return { ok: true };
  } catch (error) {
    const message = error instanceof DatabaseError ? error.message : "Couldn't remove bookmark. Try again.";
    return { ok: false, error: message };
  }
}
