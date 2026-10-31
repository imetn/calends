-- Owner-chosen device name; NULL falls back to the browser and OS parsed from user_agent.
ALTER TABLE sessions ADD COLUMN name TEXT;
