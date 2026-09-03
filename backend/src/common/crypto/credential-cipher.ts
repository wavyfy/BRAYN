import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export class InvalidEncryptionKeyError extends Error {}

/**
 * Validates BRAYN_CREDENTIAL_ENCRYPTION_KEY (doc 18 — Secrets). Expected
 * shape: 64 hex characters = 32 raw bytes, the key length AES-256 requires.
 */
export function parseEncryptionKey(rawHexKey: string | undefined): Buffer {
  if (!rawHexKey) {
    throw new InvalidEncryptionKeyError('BRAYN_CREDENTIAL_ENCRYPTION_KEY is not configured.');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(rawHexKey)) {
    throw new InvalidEncryptionKeyError('BRAYN_CREDENTIAL_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).');
  }
  return Buffer.from(rawHexKey, 'hex');
}

/**
 * App-level AES-256-GCM credential encryption (doc 18 — provider secrets
 * must not be stored as ordinary application data and must use secure
 * storage). A fresh random IV is generated per call, so encrypting the
 * same plaintext twice never produces the same ciphertext. Output packs
 * iv|authTag|ciphertext into one base64 blob — everything decrypt() needs
 * and nothing more; no key material is ever stored alongside it.
 *
 * Key rotation is not implemented: rotating BRAYN_CREDENTIAL_ENCRYPTION_KEY
 * makes existing stored credentials undecryptable. Deferred future
 * capability, not required for this framework part.
 */
export function encryptCredential(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new InvalidEncryptionKeyError(`Encryption key must be ${KEY_BYTES} bytes.`);
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/** Throws if `key` is wrong, or `payload` was truncated/tampered with (GCM auth-tag check fails). */
export function decryptCredential(payload: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new InvalidEncryptionKeyError(`Encryption key must be ${KEY_BYTES} bytes.`);
  }

  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, IV_BYTES);
  const authTag = buf.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + AUTH_TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
