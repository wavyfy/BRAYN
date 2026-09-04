import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestContext } from './request-context';
import { StructuredLoggerService } from './structured-logger.service';

describe('StructuredLoggerService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a JSON line with the expected shape', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new StructuredLoggerService();

    logger.log('hello', 'TestContext');

    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(parsed).toMatchObject({
      level: 'log',
      message: 'hello',
      context: 'TestContext',
    });
    expect(typeof parsed.timestamp).toBe('string');
  });

  it('includes the ambient correlation id when inside a request context', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new StructuredLoggerService();

    RequestContext.run({ correlationId: 'req-123' }, () => {
      logger.log('inside request', 'TestContext');
    });

    const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(parsed.correlationId).toBe('req-123');
  });

  it('routes error-level logs to console.error, including the trace', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = new StructuredLoggerService();

    logger.error('boom', 'some stack', 'TestContext');

    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(parsed.level).toBe('error');
    expect(parsed.trace).toBe('some stack');
  });

  it('scrubs an email address out of the message', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new StructuredLoggerService();

    logger.log('Customer lookup failed for jane@example.com', 'TestContext');

    const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(parsed.message).toBe('Customer lookup failed for [redacted-email]');
  });

  it('scrubs a Bearer token out of the trace field in meta', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = new StructuredLoggerService();

    logger.error('boom', 'Authorization: Bearer abcDEF123.token-value', 'TestContext');

    const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(parsed.trace).toBe('Authorization: Bearer [redacted-token]');
    expect(JSON.stringify(parsed)).not.toContain('abcDEF123.token-value');
  });
});
