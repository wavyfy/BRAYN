import { describe, expect, it } from 'vitest';
import { scrubSensitive } from './scrub-sensitive';

describe('scrubSensitive', () => {
  it('redacts an email address', () => {
    expect(scrubSensitive('Failed to notify jane.doe+test@example.co.uk about the order.')).toBe(
      'Failed to notify [redacted-email] about the order.',
    );
  });

  it('redacts a Bearer token', () => {
    expect(scrubSensitive('rejected request with Authorization: Bearer abc123.def456-ghi')).toBe(
      'rejected request with Authorization: Bearer [redacted-token]',
    );
  });

  it('redacts a Shopify access-token pattern', () => {
    const input = 'Shopify rejected credential shpat_EXAMPLEPLACEHOLDERNOTAREALTOKEN';
    const result = scrubSensitive(input);

    expect(result).toBe('Shopify rejected credential [redacted-shopify-token]');
    expect(result).not.toContain('EXAMPLEPLACEHOLDERNOTAREALTOKEN');
  });

  it('redacts a long hex/base64 token-like string', () => {
    const token = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6';
    const result = scrubSensitive(`db connection failed, token=${token}`);

    expect(result).toBe('db connection failed, token=[redacted-token]');
    expect(result).not.toContain(token);
  });

  it('leaves ordinary non-sensitive text fully intact', () => {
    const message = 'Shopify connection check failed with status 502.';
    expect(scrubSensitive(message)).toBe(message);
  });

  it('does not redact a UUID (dash-separated, not a bare token shape)', () => {
    const message = 'No customer with id 3fa85f64-5717-4562-b3fc-2c963f66afa6 exists in this workspace.';
    expect(scrubSensitive(message)).toBe(message);
  });

  it('redacts multiple distinct sensitive values in the same string', () => {
    const message = 'user jane@example.com used Bearer sometoken123 to call the API';
    const result = scrubSensitive(message);

    expect(result).toBe('user [redacted-email] used Bearer [redacted-token] to call the API');
  });
});
