import { describe, expect, it } from "vitest";
import type { Conversation } from "@/types";
import {
  conversationDot,
  isReplyWindowOpen,
  applyInboxFilter,
  isAwaitingReply,
  isWindowClosing,
  parseInboxFilter,
} from "./inbox-filters";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function conv(id: string, patch: Partial<Conversation> = {}): Conversation {
  return {
    id,
    user_id: "u",
    contact_id: `c-${id}`,
    status: "open",
    unread_count: 0,
    created_at: ago(2000),
    updated_at: ago(1),
    ...patch,
  };
}

describe("parseInboxFilter", () => {
  it("accepts every known filter and falls back to all", () => {
    expect(parseInboxFilter("waiting")).toBe("waiting");
    expect(parseInboxFilter("expiring")).toBe("expiring");
    expect(parseInboxFilter("bogus")).toBe("all");
    expect(parseInboxFilter(null)).toBe("all");
  });
});

describe("isAwaitingReply", () => {
  it("is true when the customer spoke last", () => {
    expect(isAwaitingReply(conv("a", { last_inbound_at: ago(10) }))).toBe(true);
    expect(isAwaitingReply(conv("b", { last_inbound_at: ago(10), last_reply_at: ago(20) }))).toBe(true);
  });

  it("is false once someone replied, or the chat is closed", () => {
    expect(isAwaitingReply(conv("a", { last_inbound_at: ago(20), last_reply_at: ago(10) }))).toBe(false);
    expect(isAwaitingReply(conv("b", { status: "closed", last_inbound_at: ago(10) }))).toBe(false);
    expect(isAwaitingReply(conv("c"))).toBe(false);
  });

  it("does not use unread_count, which resets when anyone opens the chat", () => {
    expect(isAwaitingReply(conv("a", { unread_count: 3 }))).toBe(false);
    expect(isAwaitingReply(conv("b", { unread_count: 0, last_inbound_at: ago(5) }))).toBe(true);
  });
});

describe("isWindowClosing", () => {
  it("flags waiting chats whose 24 h window ends within 2 h", () => {
    expect(isWindowClosing(conv("a", { last_inbound_at: ago(23 * 60) }), NOW)).toBe(true);
    expect(isWindowClosing(conv("b", { last_inbound_at: ago(20 * 60) }), NOW)).toBe(false);
    expect(isWindowClosing(conv("c", { last_inbound_at: ago(25 * 60) }), NOW)).toBe(false);
  });

  it("ignores chats that already got a reply", () => {
    expect(
      isWindowClosing(conv("a", { last_inbound_at: ago(23 * 60), last_reply_at: ago(60) }), NOW),
    ).toBe(false);
  });
});

describe("applyInboxFilter", () => {
  const list = [
    conv("recent", { last_inbound_at: ago(5) }),
    conv("old", { last_inbound_at: ago(90), assigned_agent_id: "agent-1" }),
    conv("answered", { last_inbound_at: ago(60), last_reply_at: ago(30) }),
    conv("pending", { status: "pending", assigned_agent_id: "agent-1" }),
    conv("unread", { unread_count: 2, assigned_agent_id: "agent-1" }),
  ];

  it("lists waiting chats oldest first", () => {
    expect(applyInboxFilter(list, "waiting", NOW).map((c) => c.id)).toEqual(["old", "recent"]);
  });

  it("lists open chats nobody is assigned to", () => {
    expect(applyInboxFilter(list, "unassigned", NOW).map((c) => c.id)).toEqual(["recent", "answered"]);
  });

  it("keeps the existing unread and status filters", () => {
    expect(applyInboxFilter(list, "unread", NOW).map((c) => c.id)).toEqual(["unread"]);
    expect(applyInboxFilter(list, "pending", NOW).map((c) => c.id)).toEqual(["pending"]);
    expect(applyInboxFilter(list, "all", NOW)).toBe(list);
  });

  it("does not reorder the caller's array", () => {
    const before = list.map((c) => c.id);
    applyInboxFilter(list, "waiting", NOW);
    expect(list.map((c) => c.id)).toEqual(before);
  });
});

describe("conversationDot (24-hour reply window)", () => {
  const NOW = Date.parse("2026-11-03T12:00:00Z");
  const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

  it("is open (purple) inside 24h and pending (amber) when pending", () => {
    expect(conversationDot({ status: "open", last_inbound_at: hoursAgo(2) }, NOW)).toBe("open");
    expect(conversationDot({ status: "pending", last_inbound_at: hoursAgo(23) }, NOW)).toBe("pending");
  });
  it("turns grey ('expired') once the 24-hour window has passed, even if still open", () => {
    expect(conversationDot({ status: "open", last_inbound_at: hoursAgo(25) }, NOW)).toBe("expired");
    expect(conversationDot({ status: "pending", last_inbound_at: hoursAgo(48) }, NOW)).toBe("expired");
  });
  it("is expired when the customer never wrote, and closed wins over everything", () => {
    expect(conversationDot({ status: "open", last_inbound_at: null }, NOW)).toBe("expired");
    expect(conversationDot({ status: "closed", last_inbound_at: hoursAgo(1) }, NOW)).toBe("closed");
  });
  it("flips exactly at the 24h boundary", () => {
    expect(isReplyWindowOpen({ last_inbound_at: hoursAgo(23.99) }, NOW)).toBe(true);
    expect(isReplyWindowOpen({ last_inbound_at: hoursAgo(24) }, NOW)).toBe(false);
  });
});

describe("archived chats", () => {
  const mk = (id: string, extra: Partial<Conversation> = {}): Conversation =>
    ({
      id, user_id: "u", contact_id: "c", status: "open", unread_count: 0,
      created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...extra,
    }) as Conversation;
  const live = mk("live", { unread_count: 2 });
  const arch = mk("arch", { unread_count: 5, archived_at: "2026-10-10T00:00:00Z" });

  it("hides archived chats from every normal view", () => {
    for (const f of ["all", "unread", "open", "unassigned"] as const) {
      expect(applyInboxFilter([live, arch], f, NOW).map((c) => c.id)).not.toContain("arch");
    }
    expect(applyInboxFilter([live, arch], "all", NOW).map((c) => c.id)).toEqual(["live"]);
  });
  it("shows only archived chats under the Archived filter", () => {
    expect(applyInboxFilter([live, arch], "archived", NOW).map((c) => c.id)).toEqual(["arch"]);
  });
  it("parses the archived filter from the URL", () => {
    expect(parseInboxFilter("archived")).toBe("archived");
  });
});
