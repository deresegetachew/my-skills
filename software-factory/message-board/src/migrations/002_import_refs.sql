-- factory-message-board: what an import needs to run twice without duplicates (#494, decision 0007 point 4).
-- A message and a context entry may carry an outside id (unique), like tasks.external_ref; an import updates by it.
-- A message's tag is the user's own word for what it is (free text, like actors.role): a GitHub import keeps the
-- marker a comment carried there (claim, owner-ask, manager-note, ...), so it isn't read as a plain note.
ALTER TABLE messages ADD COLUMN external_ref text UNIQUE;
ALTER TABLE messages ADD COLUMN tag text;
ALTER TABLE context ADD COLUMN external_ref text UNIQUE;
