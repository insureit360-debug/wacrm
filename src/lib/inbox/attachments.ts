/**
 * Pure helpers for attaching several files to one chat at once.
 * (The composer component stays thin; the rules live here so they are tested.)
 */

/** Most files that can wait in the attachment tray at one time. */
export const MAX_ATTACHMENTS = 10;
/** How many files upload at the same time. */
export const UPLOAD_CONCURRENCY = 3;

/**
 * How many of `incoming` fit in the tray. Returns the ones to keep and how
 * many were left out, so the UI can say so instead of dropping them silently.
 */
export function limitToRoom<T>(
  existingCount: number,
  incoming: T[],
  max: number = MAX_ATTACHMENTS,
): { accepted: T[]; dropped: number } {
  const room = Math.max(0, max - existingCount);
  return {
    accepted: incoming.slice(0, room),
    dropped: Math.max(0, incoming.length - room),
  };
}

export type PoolResult<R> =
  | { ok: true; value: R }
  | { ok: false; error: unknown };

/**
 * Runs `fn` over `items` with at most `concurrency` in flight. Results come
 * back in INPUT order (so attachments keep the order the user picked them),
 * and one failure never stops the others.
 */
export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onSettled?: (done: number, total: number) => void,
): Promise<PoolResult<R>[]> {
  const results: PoolResult<R>[] = new Array(items.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
      done++;
      onSettled?.(done, items.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker),
  );
  return results;
}

/**
 * Sends one at a time, in order, waiting for each to finish so the chat shows
 * them in the order they were picked. One failing send does not stop the rest.
 */
export async function sendInOrder<T>(
  items: T[],
  send: (item: T, index: number) => void | Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i++) {
    try {
      await send(items[i], i);
    } catch {
      /* the sender reports its own failure; keep going with the rest */
    }
  }
}
