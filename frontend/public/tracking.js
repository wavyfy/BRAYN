/**
 * BRAYN Website Tracking SDK (doc02/doc06/doc20 "Website Tracking" —
 * capture mechanism, Part 2). Provider-agnostic: a plain script tag,
 * embeddable on any storefront (Shopify, WooCommerce, or a custom site)
 * — the canonical docs specify a "Website tracking SDK" (doc02), not a
 * platform-specific pixel, and doc06 treats Website Tracking as its own
 * integration source, separate from the Shopify/WooCommerce adapters.
 *
 * Usage:
 *   <script
 *     src="https://<this-frontend-origin>/tracking.js"
 *     data-api-base="https://api.brayn.example"
 *     data-workspace-id="<workspace uuid>"
 *     data-write-key="<key from POST /workspaces/:id/website-tracking/write-key>"
 *   ></script>
 *
 * Then, wherever the storefront theme has the relevant context:
 *   window.brayn.track('product_view', { productId: '123' });
 *   window.brayn.track('search', { query: 'blue shoes' });
 *   window.brayn.track('cart', { action: 'add', productId: '123', quantity: 1 });
 *   window.brayn.track('checkout', { orderId: '456', total: '39.99' });
 *
 * `page_view` is captured automatically on script load — no call needed.
 *
 * CORS: deliberately sent as a CORS-"simple" request (see below) so the
 * ingestion endpoint (backend/src/domains/website-tracking/website-event.
 * controller.ts) never needs a CORS response header for an arbitrary
 * merchant storefront origin — see that controller's doc comment for
 * the full reasoning. Do not add custom headers or switch the body to
 * `application/json` without re-reading that comment first: either
 * change turns this into a preflighted request, which the backend does
 * not answer.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;

  var apiBase = script.getAttribute('data-api-base');
  var workspaceId = script.getAttribute('data-workspace-id');
  var writeKey = script.getAttribute('data-write-key');
  if (!apiBase || !workspaceId || !writeKey) {
    // Fail silently on a storefront — a tracking snippet must never break the page.
    return;
  }

  var VISITOR_KEY = 'brayn_visitor_id';
  var SESSION_KEY = 'brayn_session_id';

  function randomId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    // Fallback for older browsers without crypto.randomUUID — not
    // cryptographically strong, but this is a client-generated
    // correlation id, not a secret (see website_visitors/sessions'
    // doc comments: BRAYN never generates these ids).
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function getOrCreate(storage, key) {
    try {
      var existing = storage.getItem(key);
      if (existing) return existing;
      var created = randomId();
      storage.setItem(key, created);
      return created;
    } catch (e) {
      // Storage unavailable (private browsing, disabled storage, ...) —
      // fall back to a per-call id rather than throwing on a storefront.
      return randomId();
    }
  }

  var visitorId = getOrCreate(window.localStorage, VISITOR_KEY);
  // sessionStorage resets per browser tab/session on its own — no manual
  // expiry logic needed to approximate doc20's "Session" concept.
  var sessionId = getOrCreate(window.sessionStorage, SESSION_KEY);

  function send(eventType, payload) {
    var body = JSON.stringify({
      visitorId: visitorId,
      sessionId: sessionId,
      eventId: randomId(),
      eventType: eventType,
      occurredAt: new Date().toISOString(),
      payload: payload || undefined,
    });

    var url = apiBase + '/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/website-events?key=' + encodeURIComponent(writeKey);

    // text/plain (not application/json) and no custom headers — keeps
    // this a CORS-simple request; see the file-level doc comment.
    if (navigator.sendBeacon) {
      var sent = navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
      if (sent) return;
    }

    // Fallback for browsers without sendBeacon, or a beacon queue that
    // rejected the send (e.g. payload too large) — best-effort, response
    // is never read (the SDK doesn't need it, and the endpoint may not
    // even send a CORS header this page could read it through anyway).
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body, keepalive: true }).catch(function () {});
  }

  send('page_view', { url: location.href, referrer: document.referrer, title: document.title });

  window.brayn = window.brayn || {};
  window.brayn.track = send;
})();
