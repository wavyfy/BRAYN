import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../../../common/errors/app-error';
import type { ProviderRegistry } from '../../provider-registry.service';
import { FlexyPeAdapter } from './flexype.adapter';
import { flexypeAbandonedCheckout, flexypeHeaders } from './flexype.test-fixtures';

describe('FlexyPeAdapter', () => {
  const adapter = new FlexyPeAdapter({} as ProviderRegistry);
  const secret = 'flexype-test-secret';

  describe('verifyWebhookSignature (shared secret in X-Flexype-Authorization)', () => {
    it('accepts the exact secret and rejects a wrong, differently sized or missing one', () => {
      expect(adapter.verifyWebhookSignature('{}', flexypeHeaders(secret), secret)).toBe(true);
      expect(
        adapter.verifyWebhookSignature('{}', flexypeHeaders('flexype-test-secreT'), secret),
      ).toBe(false);
      expect(adapter.verifyWebhookSignature('{}', flexypeHeaders('short'), secret)).toBe(false);
      expect(adapter.verifyWebhookSignature('{}', flexypeHeaders(''), secret)).toBe(false);
      expect(adapter.verifyWebhookSignature('{}', { 'x-webhook-version': '2026-05' }, secret)).toBe(
        false,
      );
    });
  });

  describe('parseWebhookEvent', () => {
    const parse = (body: unknown, headers: Record<string, string> = flexypeHeaders(secret)) =>
      adapter.parseWebhookEvent(JSON.stringify(body), headers);

    it('normalizes ABANDONED_CHECKOUT into a minimized checkout signal keyed by X-Event-Id', () => {
      const parsed = parse(flexypeAbandonedCheckout());

      expect(parsed).toEqual({
        externalEventId: 'evt_header_1',
        eventType: 'ABANDONED_CHECKOUT',
        store: { provider: 'shopify', domain: 'test-store.myshopify.com' },
        payload: {
          resource: 'checkout',
          data: {
            kind: 'abandoned',
            sessionId: 'sess_123',
            stage: 'PAYMENT_INITIATED',
            occurredAt: '2026-11-24T10:15:00.000Z',
            shopDomain: 'test-store.myshopify.com',
            currency: 'INR',
            email: 'shopper@example.com',
            phone: '+919876543210',
            customerType: 'REPEAT',
            items: [
              {
                productExternalId: '111',
                variantExternalId: '222',
                quantity: 2,
                totalPrice: '1998',
              },
              {
                productExternalId: '333',
                variantExternalId: null,
                quantity: 0,
                totalPrice: '499.00',
              },
            ],
          },
        },
      });
    });

    it('drops IP, user agent, ad ids, UTM, coupons, checkout URL and names at the boundary', () => {
      const stored = JSON.stringify(parse(flexypeAbandonedCheckout()));
      for (const dropped of [
        '203.0.113.7',
        'Mozilla',
        'fb.1.123',
        'utm_source',
        'SAVE10',
        'secret-token',
        'Test Shopper',
        'Shirt',
        'shirt',
      ]) {
        expect(stored).not.toContain(dropped);
      }
    });

    it('falls back to dial_code + phone when phone_with_dial_code is absent', () => {
      const body = flexypeAbandonedCheckout(
        {},
        { user: { dial_code: '+91', phone: '98765 43210' } },
      );
      expect(
        (parse(body)?.payload as { data: { phone: string | null; email: string | null } }).data,
      ).toMatchObject({ phone: '+919876543210', email: null });
    });

    it('acknowledges but ignores event types BRAYN does not process', () => {
      for (const eventType of [
        'ABANDONED_SESSION',
        'PRODUCT_VIEWED',
        'COLLECTION_VIEWED',
        'CUSTOMER_CREATED',
        'NEW_CUSTOMER',
        'SOMETHING_NEW',
      ]) {
        expect(parse(flexypeAbandonedCheckout({ event_type: eventType }))).toBeNull();
      }
    });

    it('rejects other payload versions (2025-09 has no event id, type, time or session id) instead of guessing', () => {
      expect(() =>
        parse(flexypeAbandonedCheckout(), flexypeHeaders(secret, 'evt', '2025-09')),
      ).toThrow(ValidationError);
      const noVersion: Record<string, string> = { ...flexypeHeaders(secret) };
      delete noVersion['x-webhook-version'];
      expect(() => parse(flexypeAbandonedCheckout(), noVersion)).toThrow(ValidationError);
    });

    it('rejects a missing X-Event-Id, invalid JSON and missing required checkout fields', () => {
      expect(() => parse(flexypeAbandonedCheckout(), flexypeHeaders(secret, ' '))).toThrow(
        ValidationError,
      );
      expect(() => adapter.parseWebhookEvent('not json', flexypeHeaders(secret))).toThrow(
        ValidationError,
      );
      expect(() => adapter.parseWebhookEvent('[]', flexypeHeaders(secret))).toThrow(
        ValidationError,
      );
      expect(() => parse(flexypeAbandonedCheckout({ store: {} }))).toThrow(ValidationError);
      expect(() => parse(flexypeAbandonedCheckout({}, { session_id: undefined }))).toThrow(
        ValidationError,
      );
      expect(() => parse(flexypeAbandonedCheckout({}, { session_state: '' }))).toThrow(
        ValidationError,
      );
      expect(() => parse(flexypeAbandonedCheckout({ event_time: 'yesterday' }))).toThrow(
        ValidationError,
      );
    });
  });
});
