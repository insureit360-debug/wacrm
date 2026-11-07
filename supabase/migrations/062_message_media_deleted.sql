-- ============================================================
-- 062_message_media_deleted.sql — mark messages whose file was deleted
--
-- When an admin deletes a customer's image/PDF from a chat to free storage,
-- the message row STAYS (its text, caption, time and sender are untouched).
-- Only its file link is cleared and these two columns record who removed
-- the file and when, so the chat can show "File deleted" instead of a
-- broken image.
--
-- Additive + idempotent: two nullable columns, nothing else changes.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS media_deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS media_deleted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
