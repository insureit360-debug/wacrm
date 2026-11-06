import type { Tag } from "@/types";

export type ContactTag = Tag & { contact_tag_id: string };

/**
 * The tag list as it should look immediately after adding/removing `tag`
 * (optimistic update). Adding a tag that is already there, or removing one
 * that is not, returns the list unchanged.
 */
export function applyTagToggle(
  current: ContactTag[],
  tag: Tag,
  on: boolean,
): ContactTag[] {
  const has = current.some((t) => t.id === tag.id);
  if (on) return has ? current : [...current, { ...tag, contact_tag_id: `pending-${tag.id}` }];
  return has ? current.filter((t) => t.id !== tag.id) : current;
}

/** Plain tags (without the join-row id) for handing to the rest of the UI. */
export function toPlainTags(list: ContactTag[]): Tag[] {
  return list.map((t) => {
    const { contact_tag_id: _ignored, ...tag } = t;
    void _ignored;
    return tag as Tag;
  });
}
