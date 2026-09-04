import { BadRequestException, Controller, Get } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { NotFoundError } from './app-error';
import { StructuredLoggerService } from '../logging/structured-logger.service';

@Controller('test')
class ThrowingController {
  @Get('app-error')
  throwAppError() {
    throw new NotFoundError('Widget not found.');
  }

  @Get('http-error')
  throwHttpError() {
    throw new BadRequestException('Name is required.');
  }

  @Get('unknown')
  throwUnknown() {
    throw new Error('connection string: postgres://user:secret@host/db');
  }

  @Get('unknown-with-pii')
  throwUnknownWithPii() {
    throw new Error('Upstream call for jane@example.com failed using Bearer sometoken123456789012345678901234');
  }
}

describe('AllExceptionsFilter (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ThrowingController],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new AllExceptionsFilter(new StructuredLoggerService()));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('formats an AppError using its own code and status', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/app-error' });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Widget not found.');
    expect(typeof body.error.requestId).toBe('string');
  });

  it('formats a Nest built-in HttpException via status mapping', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/http-error' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it("never leaks an unknown error's message to the client", async () => {
    const res = await app.inject({ method: 'GET', url: '/test/unknown' });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('An unexpected error occurred.');
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('scrubs an unhandled exception message/trace before logging it server-side', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await app.inject({ method: 'GET', url: '/test/unknown-with-pii' });

    expect(res.statusCode).toBe(500);
    const logged = errorSpy.mock.calls.map((call) => JSON.parse(call[0] as string)).find((line) => line.context === 'AllExceptionsFilter');
    expect(logged).toBeDefined();
    expect(logged.message).toBe('Upstream call for [redacted-email] failed using Bearer [redacted-token]');
    expect(logged.trace).toContain('Upstream call for [redacted-email] failed using Bearer [redacted-token]');
    expect(JSON.stringify(logged)).not.toContain('jane@example.com');
    expect(JSON.stringify(logged)).not.toContain('sometoken123456789012345678901234');
  });
});
