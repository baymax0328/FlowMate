ALTER TABLE conversation_members ADD COLUMN pinned_at TEXT;
ALTER TABLE conversation_members ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_members ADD COLUMN manual_unread INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_members ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_members ADD COLUMN history_cutoff INTEGER NOT NULL DEFAULT 0;

-- Stable message positions preserve personal history boundaries across database exports.
ALTER TABLE messages ADD COLUMN history_seq INTEGER NOT NULL DEFAULT 0;
UPDATE messages SET history_seq=rowid;
CREATE INDEX ix_messages_history_seq ON messages(conversation_id, history_seq);
CREATE TRIGGER messages_assign_history_seq AFTER INSERT ON messages
WHEN NEW.history_seq=0
BEGIN
  UPDATE messages SET history_seq=COALESCE((
    SELECT MAX(history_seq) FROM messages WHERE conversation_id=NEW.conversation_id
  ), 0) + 1 WHERE id=NEW.id;
END;
