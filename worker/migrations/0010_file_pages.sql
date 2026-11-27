-- Store PDF page count so multi-page documents can render stacked previews without re-reading the file.
ALTER TABLE files ADD COLUMN pages INTEGER;
