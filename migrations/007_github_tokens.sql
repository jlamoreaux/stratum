-- Add GitHub access token storage for private repo support
ALTER TABLE users ADD COLUMN github_access_token TEXT;

-- Create index for faster lookups (though this is encrypted/tokenized data)
CREATE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id);
