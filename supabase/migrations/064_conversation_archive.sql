-- ============================================================
-- 064_conversation_archive.sql — archive chats (like WhatsApp Business)
--
-- Archiving a chat only sets `conversations.archived_at`. Nothing else
-- changes: messages, contact, tags, notes, follow-ups and the chat's
-- status all stay as they are. Archived chats are hidden from the main
-- inbox and shown under the "Archived" filter; unarchiving clears the date.
--
-- Like WhatsApp, when the customer writes again the chat comes back to the
-- main inbox on its own, so an enquiry is never missed. This is done by a
-- small trigger on incoming messages, so no application code on the
-- WhatsApp webhook path had to change.
--
-- Additive + idempotent.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE OR REPLACE FUNCTION public.unarchive_conversation_on_inbound()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE conversations
     SET archived_at = NULL
   WHERE id = NEW.conversation_id
     AND archived_at IS NOT NULL;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.unarchive_conversation_on_inbound() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.unarchive_conversation_on_inbound() FROM PUBLIC;

DROP TRIGGER IF EXISTS messages_unarchive_on_inbound ON messages;
CREATE TRIGGER messages_unarchive_on_inbound
  AFTER INSERT ON messages
  FOR EACH ROW
  WHEN (NEW.sender_type = 'customer')
  EXECUTE FUNCTION public.unarchive_conversation_on_inbound();
