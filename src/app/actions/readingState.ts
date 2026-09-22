"use server";

import { addToQueue, removeFromQueue, markRead, markUnread, DatabaseError } from "@/db/repository";
import { validateSourceKey } from "@/lib/sourceKey";

export interface ReadingStateActionResult {
  ok: boolean;
  error?: string;
}

export async function addToQueueAction(sourceKey: unknown): Promise<ReadingStateActionResult> {
  const validated = validateSourceKey(sourceKey);
  if (!validated) return { ok: false, error: "Couldn't queue this item. Try again." };

  try {
    await addToQueue(validated);
    return { ok: true };
  } catch (error) {
    const message = error instanceof DatabaseError ? error.message : "Couldn't queue this item. Try again.";
    return { ok: false, error: message };
  }
}

export async function removeFromQueueAction(sourceKey: unknown): Promise<ReadingStateActionResult> {
  const validated = validateSourceKey(sourceKey);
  if (!validated) return { ok: false, error: "Couldn't remove this item from the queue. Try again." };

  try {
    await removeFromQueue(validated);
    return { ok: true };
  } catch (error) {
    const message =
      error instanceof DatabaseError ? error.message : "Couldn't remove this item from the queue. Try again.";
    return { ok: false, error: message };
  }
}

export async function markReadAction(sourceKey: unknown): Promise<ReadingStateActionResult> {
  const validated = validateSourceKey(sourceKey);
  if (!validated) return { ok: false, error: "Couldn't mark this item read. Try again." };

  try {
    await markRead(validated);
    return { ok: true };
  } catch (error) {
    const message = error instanceof DatabaseError ? error.message : "Couldn't mark this item read. Try again.";
    return { ok: false, error: message };
  }
}

export async function markUnreadAction(sourceKey: unknown): Promise<ReadingStateActionResult> {
  const validated = validateSourceKey(sourceKey);
  if (!validated) return { ok: false, error: "Couldn't mark this item unread. Try again." };

  try {
    await markUnread(validated);
    return { ok: true };
  } catch (error) {
    const message = error instanceof DatabaseError ? error.message : "Couldn't mark this item unread. Try again.";
    return { ok: false, error: message };
  }
}
