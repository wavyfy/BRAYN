import { describe, expect, it } from 'vitest';
import { decryptCredential, encryptCredential, InvalidEncryptionKeyError, parseEncryptionKey } from './credential-cipher';

const KEY = Buffer.from('a'.repeat(64), 'hex');

describe('credential-cipher', () => {
  it('round-trips plaintext through encrypt/decrypt', () => {
    const plaintext = JSON.stringify({ accessToken: 'shpat_secret', scope: 'read_orders' });

    const ciphertext = encryptCredential(plaintext, KEY);

    expect(ciphertext).not.toContain('shpat_secret');
    expect(decryptCredential(ciphertext, KEY)).toBe(plaintext);
  });

  it('produces different ciphertext for the same plaintext on each call', () => {
    const plaintext = 'same-secret';

    const a = encryptCredential(plaintext, KEY);
    const b = encryptCredential(plaintext, KEY);

    expect(a).not.toBe(b);
    expect(decryptCredential(a, KEY)).toBe(plaintext);
    expect(decryptCredential(b, KEY)).toBe(plaintext);
  });

  it('rejects a tampered ciphertext', () => {
    const ciphertext = encryptCredential('secret', KEY);
    const bytes = Buffer.from(ciphertext, 'base64');
    bytes[bytes.length - 1] ^= 0xff; // flip a byte inside the encrypted payload
    const tampered = bytes.toString('base64');

    expect(() => decryptCredential(tampered, KEY)).toThrow();
  });

  it('rejects decryption with the wrong key', () => {
    const ciphertext = encryptCredential('secret', KEY);
    const wrongKey = Buffer.from('b'.repeat(64), 'hex');

    expect(() => decryptCredential(ciphertext, wrongKey)).toThrow();
  });

  describe('parseEncryptionKey', () => {
    it('accepts a valid 64-character hex key', () => {
      expect(parseEncryptionKey('a'.repeat(64))).toEqual(KEY);
    });

    it('throws when the key is missing', () => {
      expect(() => parseEncryptionKey(undefined)).toThrow(InvalidEncryptionKeyError);
    });

    it('throws when the key is the wrong length', () => {
      expect(() => parseEncryptionKey('a'.repeat(32))).toThrow(InvalidEncryptionKeyError);
    });

    it('throws when the key is not valid hex', () => {
      expect(() => parseEncryptionKey('z'.repeat(64))).toThrow(InvalidEncryptionKeyError);
    });
  });
});
