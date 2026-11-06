import { describe, expect, it } from "vitest";
import type { Tag } from "@/types";
import { applyTagToggle, toPlainTags, type ContactTag } from "./tag-toggle";

const tag = (id: string, name = id): Tag => ({ id, name, color: "#8b5cf6" }) as Tag;
const attached = (id: string): ContactTag => ({ ...tag(id), contact_tag_id: `ct-${id}` });

describe("applyTagToggle", () => {
  it("adds a tag that is missing", () => {
    const out = applyTagToggle([attached("a")], tag("b"), true);
    expect(out.map((t) => t.id)).toEqual(["a", "b"]);
    expect(out[1].contact_tag_id).toBe("pending-b");
  });
  it("does not duplicate an existing tag", () => {
    const list = [attached("a")];
    expect(applyTagToggle(list, tag("a"), true)).toBe(list);
  });
  it("removes only the chosen tag", () => {
    const out = applyTagToggle([attached("a"), attached("b")], tag("a"), false);
    expect(out.map((t) => t.id)).toEqual(["b"]);
  });
  it("removing a tag that is not attached changes nothing", () => {
    const list = [attached("a")];
    expect(applyTagToggle(list, tag("z"), false)).toBe(list);
  });
  it("toPlainTags drops the join-row id", () => {
    expect(toPlainTags([attached("a")])).toEqual([tag("a")]);
  });
});
