/** A 2026-05 ABANDONED_CHECKOUT body shaped like docs.flexype.io/webhooks/2026-05/acr (synthetic values). */
export function flexypeAbandonedCheckout(
  overrides: Record<string, unknown> = {},
  payloadOverrides: Record<string, unknown> = {},
) {
  return {
    event_time: '2026-11-24T10:15:00.000Z',
    event_type: 'ABANDONED_CHECKOUT',
    event_id: 'evt_body_1',
    store: {
      id: 'st_1',
      name: 'Test Store',
      shopify_domain: 'Test-Store.myshopify.com',
      main_domain: 'teststore.example',
    },
    payload: {
      session_id: 'sess_123',
      checkout_url: 'https://checkout.flexype.example/sess_123?token=secret-token',
      checkout_context: {
        store_country: 'IN',
        store_currency: 'INR',
        presentment_country: 'IN',
        presentment_currency: 'INR',
      },
      user: {
        email: ' Shopper@Example.COM ',
        full_name: 'Test Shopper',
        first_name: 'Test',
        last_name: 'Shopper',
        dial_code: '+91',
        phone: '9876543210',
        phone_with_dial_code: '+91 98765 43210',
        customer_type: 'REPEAT',
      },
      cart_items: [
        {
          title: 'Shirt',
          product_id: 111,
          variant_id: '222',
          quantity: 2,
          total_price: 1998,
          handle: 'shirt',
        },
        { title: 'Cap', product_id: '333', variant_id: null, quantity: 'x', total_price: '499.00' },
      ],
      session_state: 'PAYMENT_INITIATED',
      coupons: [{ code: 'SAVE10' }],
      client_meta: {
        client_ip: '203.0.113.7',
        user_agent: 'Mozilla/5.0',
        http_referer: 'https://ref.example',
      },
      metadata: { utm: [{ name: 'utm_source', value: 'ads' }], landing_page: '/x' },
      analytics: { fb: { fbp: 'fb.1.123' } },
      ...payloadOverrides,
    },
    ...overrides,
  };
}

export const flexypeHeaders = (secret: string, eventId = 'evt_header_1', version = '2026-05') => ({
  'x-flexype-authorization': secret,
  'x-webhook-version': version,
  'x-event-id': eventId,
  'content-type': 'application/json',
});
