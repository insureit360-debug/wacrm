import type { Conversation, ConversationStatus } from "@/types";

export const INBOX_FILTERS = [
  "all",
  "unread",
  "waiting",
  "unassigned",
  "expiring",
  "open",
  "pending",
  "closed",
  "archived",
] as const;

export type InboxFilter = (typeof INBOX_FILTERS)[number];

const WINDOW_MS = 24 * 60 * 60 * 1000;
const EXPIRING_WITHIN_MS = 2 * 60 * 60 * 1000;

export function parseInboxFilter(raw: string | null | undefined): InboxFilter {
  return (INBOX_FILTERS as readonly string[]).includes(raw ?? "")
    ? (raw as InboxFilter)
    : "all";
}

export function isAwaitingReply(c: Conversation): boolean {
  if (c.status === "closed" || !c.last_inbound_at) return false;
  if (!c.last_reply_at) return true;
  return new Date(c.last_reply_at).getTime() < new Date(c.last_inbound_at).getTime();
}

export function isWindowClosing(c: Conversation, now: number): boolean {
  if (!isAwaitingReply(c) || !c.last_inbound_at) return false;
  const closesAt = new Date(c.last_inbound_at).getTime() + WINDOW_MS;
  return closesAt > now && closesAt - now <= EXPIRING_WITHIN_MS;
}

/**
 * WhatsApp only allows free-form replies for 24 hours after the customer's
 * last message. Outside it you must use an approved template.
 */
export function isReplyWindowOpen(
  c: Pick<Conversation, "last_inbound_at">,
  now: number,
): boolean {
  if (!c.last_inbound_at) return false;
  return new Date(c.last_inbound_at).getTime() + WINDOW_MS > now;
}

export type ConversationDot = "open" | "pending" | "expired" | "closed";

/** What the small dot in the inbox list shows for a conversation. */
export function conversationDot(
  c: Pick<Conversation, "status" | "last_inbound_at">,
  now: number,
): ConversationDot {
  if (c.status === "closed") return "closed";
  if (!isReplyWindowOpen(c, now)) return "expired";
  return c.status === "pending" ? "pending" : "open";
}

function byOldestInbound(a: Conversation, b: Conversation): number {
  return (a.last_inbound_at ?? "").localeCompare(b.last_inbound_at ?? "");
}

export function applyInboxFilter(
  conversations: Conversation[],
  filter: InboxFilter,
  now: number,
): Conversation[] {
  // Archived chats live only under the "Archived" filter; every other view
  // (All, Unread, Waiting, ...) hides them, like WhatsApp Business.
  if (filter === "archived") return conversations.filter((c) => !!c.archived_at);
  const live = conversations.some((c) => c.archived_at)
    ? conversations.filter((c) => !c.archived_at)
    : conversations;
  switch (filter) {
    case "all":
      return live;
    case "unread":
      return live.filter((c) => c.unread_count > 0);
    case "waiting":
      return live.filter(isAwaitingReply).sort(byOldestInbound);
    case "expiring":
      return live.filter((c) => isWindowClosing(c, now)).sort(byOldestInbound);
    case "unassigned":
      return live.filter((c) => c.status === "open" && !c.assigned_agent_id);
    default:
      return live.filter((c) => c.status === (filter as ConversationStatus));
  }
}
