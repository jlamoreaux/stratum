-- Migration 009: Add username column to users table
-- This supports the namespace feature by giving each user a unique username

-- Add username column (nullable initially for migration)
ALTER TABLE users ADD COLUMN username TEXT;

-- Note: After adding this column, existing users will have NULL username.
-- You need to manually populate usernames or use the application logic
-- to generate usernames for existing users when they log in.

-- Create unique index on username
CREATE UNIQUE INDEX idx_users_username ON users(username);

-- Create index for username lookups
CREATE INDEX idx_users_username_lookup ON users(username);

-- To populate usernames for existing users, run this after deployment:
-- UPDATE users SET username = LOWER(SUBSTR(email, 1, LENGTH(email) - LENGTH(SUBSTR(email, INSTR(email, '@'))))) WHERE username IS NULL;
-- Then handle any duplicates manually.
