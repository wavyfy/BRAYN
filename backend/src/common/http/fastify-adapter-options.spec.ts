import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { fastifyAdapterOptions } from './fastify-adapter-options';

/** A server built with the API's real options, echoing what `request.ip` resolves to. */
async function ipFor(hops: number, remoteAddress: string, forwardedFor?: string): Promise<string> {
  const app = Fastify(fastifyAdapterOptions({ TRUST_PROXY_HOPS: hops }));
  app.get('/ip', async (request) => ({ ip: request.ip }));
  const res = await app.inject({
    method: 'GET',
    url: '/ip',
    remoteAddress,
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
  });
  await app.close();
  return res.json<{ ip: string }>().ip;
}

const PROXY = '10.0.0.5'; // the socket peer behind a load balancer
const CLIENT = '198.51.100.23';

describe('fastifyAdapterOptions trustProxy', () => {
  it('with 0 hops ignores X-Forwarded-For entirely: request.ip is the socket peer', async () => {
    expect(await ipFor(0, PROXY, CLIENT)).toBe(PROXY);
  });

  it('with 1 hop takes the entry the proxy appended (rightmost)', async () => {
    expect(await ipFor(1, PROXY, CLIENT)).toBe(CLIENT);
  });

  it('with 1 hop ignores a client-forged entry on the left (proxy only appends)', async () => {
    expect(await ipFor(1, PROXY, `1.2.3.4, ${CLIENT}`)).toBe(CLIENT);
  });

  it('with 2 hops (e.g. CDN → load balancer) skips the inner proxy entry and still ignores forged entries', async () => {
    const CDN = '172.70.1.1';
    expect(await ipFor(2, PROXY, `1.2.3.4, ${CLIENT}, ${CDN}`)).toBe(CLIENT);
  });

  it('with no X-Forwarded-For header falls back to the socket peer', async () => {
    expect(await ipFor(1, PROXY)).toBe(PROXY);
  });
});
