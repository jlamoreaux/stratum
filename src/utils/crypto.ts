/**
 * Cryptographic utilities for secure token storage and API key generation
 */

const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;

/**
 * Hash a token using SHA-256
 */
export async function hashToken(plaintext: string): Promise<string> {
  const encoded = new TextEncoder().encode(plaintext);
  const buffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verify a token against a hash using constant-time comparison
 */
export async function verifyToken(plaintext: string, hash: string): Promise<boolean> {
  const candidate = await hashToken(plaintext);
  return constantTimeEqual(candidate, hash);
}

/**
 * Compare two strings without a value-dependent early exit, to avoid leaking
 * how many leading characters matched via timing.
 *
 * Caveat: this short-circuits when the lengths differ, so it leaks *length* by
 * timing. That is acceptable only for fixed-length secrets (hex hashes, the
 * admin API key). Do not use it to compare variable-length user input where the
 * length itself is sensitive.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Generate a random API key with prefix
 */
export async function generateApiKey(prefix: string): Promise<string> {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}_${hex}`;
}

/**
 * The historical hardcoded salt. It predates any second use of the AES-GCM
 * helpers, so it stays the default: every existing GitHub-token ciphertext was
 * produced under it and must keep decrypting byte-for-byte.
 */
const GITHUB_TOKEN_SALT = "stratum-github-token-salt";

/** PBKDF2 salt for SSO client-secret encryption (keyed off SSO_ENCRYPTION_SECRET). */
export const SSO_SECRET_SALT = "stratum-sso-secret-salt";

/**
 * Derive encryption key from environment secret using PBKDF2. The salt
 * partitions key material per use-case so two subsystems sharing this helper
 * can never decrypt each other's ciphertexts even under a reused env secret.
 */
async function getEncryptionKey(secret: string, salt: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);

  const baseKey = await crypto.subtle.importKey("raw", keyData, { name: "PBKDF2" }, false, [
    "deriveBits",
    "deriveKey",
  ]);

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode(salt),
      iterations: 100000,
      hash: "SHA-256",
    },
    baseKey,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt a secret using AES-GCM (GitHub-token salt by default).
 */
export async function encryptToken(
  plaintext: string,
  secret: string,
  salt: string = GITHUB_TOKEN_SALT,
): Promise<string> {
  const key = await getEncryptionKey(secret, salt);
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    encoder.encode(plaintext),
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);

  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a secret encrypted by `encryptToken` (same salt required).
 */
export async function decryptToken(
  ciphertext: string,
  secret: string,
  salt: string = GITHUB_TOKEN_SALT,
): Promise<string | null> {
  try {
    const key = await getEncryptionKey(secret, salt);

    const combined = new Uint8Array(
      atob(ciphertext)
        .split("")
        .map((c) => c.charCodeAt(0)),
    );

    const iv = combined.slice(0, 12);
    const encrypted = combined.slice(12);

    const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, encrypted);

    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}
