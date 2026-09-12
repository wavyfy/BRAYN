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
    expect(config.OPENAI_API_KEY).toBeUndefined();
    expect(config.AI_MODEL).toBe('gpt-5.6-luna');
  });

  it('rejects an empty OPENAI_API_KEY rather than treating it as unset', () => {
    process.env = { ...originalEnv, NODE_ENV: 'test', OPENAI_API_KEY: '' } as NodeJS.ProcessEnv;

    expect(() => loadConfiguration()).toThrow(/Invalid environment configuration/);
  });

  it('accepts a configured OPENAI_API_KEY and AI_MODEL override', () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      OPENAI_API_KEY: 'sk-test-placeholder',
      AI_MODEL: 'gpt-5.6-luna-mini',
    } as NodeJS.ProcessEnv;

    const config = loadConfiguration();

    expect(config.OPENAI_API_KEY).toBe('sk-test-placeholder');
    expect(config.AI_MODEL).toBe('gpt-5.6-luna-mini');
  });

  it('throws on a malformed defined variable', () => {
    process.env = {
      ...originalEnv,
      DATABASE_URL: 'not-a-url',
    } as NodeJS.ProcessEnv;

    expect(() => loadConfiguration()).toThrow(/Invalid environment configuration/);
  });
});
