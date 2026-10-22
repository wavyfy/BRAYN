import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { warnOnMissingProductionSecrets } from './common/config/startup-checks';
import { registerHttpLogging } from './common/logging/http-logging.hook';
import { fastifyAdapterOptions } from './common/http/fastify-adapter-options';
import { StructuredLoggerService } from './common/logging/structured-logger.service';
import { initSentry } from './common/observability/sentry';
import { loadConfiguration } from './config/configuration';
import { WebhookEventProcessorService } from './domains/integration/webhook-event-processor.service';
import type { Env } from './config/env.schema';

async function bootstrap() {
  // AppModule's ConfigModule.forRoot() has already loaded .env into process.env at import time.
  const env = loadConfiguration();
  const adapter = new FastifyAdapter(fastifyAdapterOptions(env));

  // rawBody: true — webhook signature verification needs the provider's
  // exact request bytes (doc 21); a Buffer built from the parsed-then-
  // re-stringified body wouldn't match a signature computed over the
  // original bytes (key order/whitespace can differ).
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, { rawBody: true });

  const configService = app.get(ConfigService<Env, true>);
  app.enableCors({ origin: configService.get('FRONTEND_URL', { infer: true }), credentials: true });

  // doc 29 §6 — REST API is versioned under /api/v1. health stays
  // unversioned: it's an infrastructure liveness check, not a business API.
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });

  const logger = app.get(StructuredLoggerService);
  app.useLogger(logger);
  registerHttpLogging(app.getHttpAdapter().getInstance(), logger);

  initSentry(configService.get('SENTRY_DSN', { infer: true }));
  warnOnMissingProductionSecrets(env, logger);

  const port = configService.get('PORT', { infer: true });
  await app.listen(port, '0.0.0.0');

  // Durable webhook recovery: sweeps pending/abandoned webhook rows (see
  // WebhookEventProcessorService). Started here, not on module init, so
  // test modules never run a background poller against the shared dev DB.
  app.get(WebhookEventProcessorService).startPolling();
}

void bootstrap();
