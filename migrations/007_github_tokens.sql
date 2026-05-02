-- Add GitHub access token storage for private repo support
-- SECURITY NOTE: These tokens are stored in plaintext. For production use,
-- this should be encrypted using envelope encryption with a KMS (e.g., AWS KMS,
-- Cloudflare Key Management, or HashiCorp Vault). The recommended approach is:
-- 1. Store ciphertext + key-id in the database
-- 2. Decrypt on-demand using the KMS when needed for API calls
-- 3. Never log or expose the plaintext token
ALTER TABLE users ADD COLUMN github_access_token TEXT;

-- Create index for faster lookups (though this is encrypted/tokenized data)
CREATE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id);
