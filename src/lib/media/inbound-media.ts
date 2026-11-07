/**
 * Safe deletion of CUSTOMER-sent files (images, PDFs, ...) that WACRM
 * mirrored into the `chat-media` bucket, to free storage.
 *
 * Safety rules (each one is unit-tested):
 *  - Only objects under `account-<this account>/inbound/<file>` can ever be
 *    removed. Outbound attachments, template/flow media, other accounts and
 *    anything with a path trick (`..`, nested folders) are refused.
 *  - The message row is never deleted. Only its `media_url` is cleared and
 *    `media_deleted_at/by` recorded; text, caption, time, sender, contact,
 *    notes and every other message are untouched.
 *  - The DB link is cleared first (conditionally), the file is removed
 *    second, and if removal fails the link is restored — so a failure can
 *    never leave a message pointing at a missing file, nor lose a file.
 *  - If another message still points at the same file, only this message's
 *    link is cleared; the shared file is kept.
 */

export const CHAT_MEDIA_BUCKET = 'chat-media'
const PUBLIC_MARKER = `/storage/v1/object/public/${CHAT_MEDIA_BUCKET}/`

/** Max messages per delete request. */
export const MAX_DELETE_BATCH = 100

/**
 * Storage path of a mirrored inbound file, or null when the URL is anything
 * else (WhatsApp-hosted proxy URL, outbound upload, other account, tricks).
 */
export function inboundMediaPath(
  mediaUrl: string | null | undefined,
  accountId: string,
): string | null {
  if (!mediaUrl || !accountId) return null
  const i = mediaUrl.indexOf(PUBLIC_MARKER)
  if (i === -1) return null
  let rest = mediaUrl.slice(i + PUBLIC_MARKER.length).split('?')[0].split('#')[0]
  try {
    rest = decodeURIComponent(rest)
  } catch {
    return null
  }
  const prefix = `account-${accountId}/inbound/`
  if (!rest.startsWith(prefix)) return null
  const name = rest.slice(prefix.length)
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null
  return rest
}

export function fileNameOfPath(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export interface MessageMediaRow {
  id: string
  media_url: string | null
  media_deleted_at?: string | null
}

/** Everything the deleter needs from the outside world (faked in tests). */
export interface DeletePorts {
  /** Messages of THIS conversation (already account-scoped) with these ids. */
  fetchMessages(ids: string[]): Promise<MessageMediaRow[]>
  /** How many OTHER messages point at the same file URL. */
  countOtherRefs(mediaUrl: string, exceptId: string): Promise<number>
  /** Clear the link only if it still equals `oldUrl`. True if one row changed. */
  claim(id: string, oldUrl: string, patch: { deletedAt: string; deletedBy: string }): Promise<boolean>
  /** Put the link back (used only if the file could not be removed). */
  restore(id: string, oldUrl: string): Promise<boolean>
  removeObject(path: string): Promise<{ error: string | null }>
  /** file name -> bytes, from the folder listing. */
  sizes: Map<string, number>
}

export type DeleteStatus = 'deleted' | 'skipped' | 'error'
export interface DeleteResult {
  id: string
  status: DeleteStatus
  reason?:
    | 'not_found'
    | 'already_deleted'
    | 'no_file'
    | 'not_deletable'
    | 'changed'
    | 'remove_failed'
    | 'shared_kept'
  bytes: number
}

export async function deleteInboundMedia(args: {
  accountId: string
  userId: string
  messageIds: string[]
  ports: DeletePorts
  now?: string
}): Promise<{ results: DeleteResult[]; freedBytes: number }> {
  const { accountId, userId, ports } = args
  const now = args.now ?? new Date().toISOString()
  const ids = Array.from(new Set(args.messageIds)).slice(0, MAX_DELETE_BATCH)
  const rows = new Map((await ports.fetchMessages(ids)).map((r) => [r.id, r]))

  const results: DeleteResult[] = []
  let freedBytes = 0

  for (const id of ids) {
    const row = rows.get(id)
    if (!row) {
      results.push({ id, status: 'skipped', reason: 'not_found', bytes: 0 })
      continue
    }
    if (row.media_deleted_at) {
      results.push({ id, status: 'skipped', reason: 'already_deleted', bytes: 0 })
      continue
    }
    if (!row.media_url) {
      results.push({ id, status: 'skipped', reason: 'no_file', bytes: 0 })
      continue
    }
    const path = inboundMediaPath(row.media_url, accountId)
    if (!path) {
      results.push({ id, status: 'skipped', reason: 'not_deletable', bytes: 0 })
      continue
    }

    const others = await ports.countOtherRefs(row.media_url, id)
    const claimed = await ports.claim(id, row.media_url, { deletedAt: now, deletedBy: userId })
    if (!claimed) {
      results.push({ id, status: 'skipped', reason: 'changed', bytes: 0 })
      continue
    }
    if (others > 0) {
      // Another message still uses this exact file: keep it.
      results.push({ id, status: 'deleted', reason: 'shared_kept', bytes: 0 })
      continue
    }

    const { error } = await ports.removeObject(path)
    if (error) {
      await ports.restore(id, row.media_url).catch(() => false)
      results.push({ id, status: 'error', reason: 'remove_failed', bytes: 0 })
      continue
    }
    const bytes = ports.sizes.get(fileNameOfPath(path)) ?? 0
    freedBytes += bytes
    results.push({ id, status: 'deleted', bytes })
  }
  return { results, freedBytes }
}

/** Minimal Storage surface used to read file sizes (service-role client). */
export interface ListableStorage {
  from(bucket: string): {
    list(
      path: string,
      options: { limit: number; offset: number },
    ): Promise<{
      data: Array<{ name: string; metadata?: { size?: number } | null }> | null
      error: { message: string } | null
    }>
  }
}

/** file name -> size in bytes for the account's whole `inbound/` folder. */
export async function listInboundSizes(
  storage: ListableStorage,
  accountId: string,
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>()
  const PAGE = 1000
  for (let page = 0; page < 50; page++) {
    const { data, error } = await storage
      .from(CHAT_MEDIA_BUCKET)
      .list(`account-${accountId}/inbound`, { limit: PAGE, offset: page * PAGE })
    if (error || !data) break
    for (const f of data) {
      const size = f.metadata?.size
      if (typeof size === 'number') sizes.set(f.name, size)
    }
    if (data.length < PAGE) break
  }
  return sizes
}
