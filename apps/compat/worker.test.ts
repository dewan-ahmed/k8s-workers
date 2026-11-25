import { describe, expect, it, vi } from 'vitest';
import worker from './worker';
import { maxRequestBytes } from './checker';

const base = 'https://compat.k8s.workers.dev';
const limit = vi.fn(async () => ({ success: true }));
const assets = { fetch: vi.fn(async (_request: Request) => new Response(null, { status: 404 })) };
const env = { ASSETS: assets, CHECK_LIMIT: { limit } };
const post = (payload: unknown, headers: Record<string, string> = {}) => new Request(`${base}/api/check`, {
  method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json', ...headers },
});

describe('compatibility Worker', () => {
  it('serves the home page through the asset binding without rewriting errors', async () => {
    const request = new Request(base);
    expect((await worker.fetch(request, env)).status).toBe(404);
    expect(assets.fetch).toHaveBeenCalledWith(request);
  });

  it('exposes configuration and returns an uncached compatibility report', async () => {
    const config = await worker.fetch(new Request(`${base}/api/config`), env);
    expect(await config.json()).toMatchObject({ minimumMinor: expect.any(Number), latestMinor: expect.any(Number) });
    const response = await worker.fetch(post({ targetVersion: '1.34', inventory: 'kubectl 1.34' }), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ targetVersion: '1.34', components: [{ supported: true }] });
  });

  it('rejects wrong methods, cross-origin requests, unsupported content types, and malformed versions', async () => {
    expect((await worker.fetch(new Request(`${base}/api/check`), env)).status).toBe(405);
    expect((await worker.fetch(post({}, { Origin: 'https://example.org' }), env)).status).toBe(403);
    expect((await worker.fetch(post({}, { 'Content-Type': 'text/plain' }), env)).status).toBe(415);
    expect((await worker.fetch(post({ targetVersion: 'not-a-version' }), env)).status).toBe(400);
  });

  it('bounds the actual request body and honors the rate limit', async () => {
    expect((await worker.fetch(post({ manifest: 'x'.repeat(maxRequestBytes) }), env)).status).toBe(413);
    limit.mockResolvedValueOnce({ success: false });
    const response = await worker.fetch(post({ targetVersion: '1.34' }), env);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
  });
});
