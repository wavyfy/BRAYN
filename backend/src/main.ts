import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { warnOnMissingProductionSecrets } from './common/config/startup-checks';
import { registerHttpLogging } from './common/logging/http-logging.hook';
import { StructuredLoggerService } from './common/logging/structured-logger.service';
import { initSentry } from './common/observability/sentry';
import { loadConfiguration } from './config/configuration';
import type { Env } from './config/env.schema';

async function bootstrap() {
  const adapter = new FastifyAdapter({
    // Honor an upstream correlation id if one was already assigned,
    // otherwise generate one — see "18. BRAYN Security, Observability &
    // Reliability" (Correlation & Traceability).
    genReqId: (request: IncomingMessage) => {
      const incoming = request.headers['x-request-id'];
      return typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
    },
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);

  // doc 29 §6 — REST API is versioned under /api/v1. health stays
  // unversioned: it's an infrastructure liveness check, not a business API.
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });

  const logger = app.get(StructuredLoggerService);
  app.useLogger(logger);
  registerHttpLogging(app.getHttpAdapter().getInstance(), logger);

  const configService = app.get(ConfigService<Env, true>);
  initSentry(configService.get('SENTRY_DSN', { infer: true }));
  warnOnMissingProductionSecrets(loadConfiguration(), logger);

  const port = configService.get('PORT', { infer: true });
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
