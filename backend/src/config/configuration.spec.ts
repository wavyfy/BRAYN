import { describe, expect, it, afterEach } from 'vitest';
import { loadConfiguration } from './configuration';

describe('loadConfiguration', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('applies defaults when optional variables are absent', () => {
    process.env = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;

    const config = loadConfiguration();

    expect(config.NODE_ENV).toBe('test');
    expect(config.PORT).toBe(3001);
    expect(config.DATABASE_URL).toBeUndefined();
  });

  it('throws on a malformed defined variable', () => {
    process.env = {
      ...originalEnv,
      DATABASE_URL: 'not-a-url',
    } as NodeJS.ProcessEnv;

    expect(() => loadConfiguration()).toThrow(/Invalid environment configuration/);
  });
});
