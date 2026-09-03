import { Body, Controller, Post } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';
import { AllExceptionsFilter } from '../errors/all-exceptions.filter';
import { StructuredLoggerService } from '../logging/structured-logger.service';

const createWidgetSchema = z.object({
  name: z.string().min(1),
  quantity: z.number().int().positive(),
});

@Controller('test')
class WidgetController {
  @Post('widgets')
  create(@Body(new ZodValidationPipe(createWidgetSchema)) body: unknown) {
    return { received: body };
  }
}

describe('ZodValidationPipe (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [WidgetController],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new AllExceptionsFilter(new StructuredLoggerService()));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('passes a valid body through unchanged', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/widgets',
      payload: { name: 'Widget', quantity: 3 },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ received: { name: 'Widget', quantity: 3 } });
  });

  it('rejects a missing required field with the canonical error envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/widgets',
      payload: { quantity: 3 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(res.json().error.message).toContain('name');
  });

  it('rejects a wrong-typed field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/widgets',
      payload: { name: 'Widget', quantity: 'not-a-number' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('strips fields not defined in the schema rather than passing them through', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/widgets',
      payload: { name: 'Widget', quantity: 3, unexpected: 'field' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ received: { name: 'Widget', quantity: 3 } });
  });
});
