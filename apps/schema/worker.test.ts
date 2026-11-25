import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import worker from './worker';

const url = 'https://schema.k8s.workers.dev';
const manifest = 'apiVersion: v1\nkind: ConfigMap\nmetadata: { name: app }\ndata: { replicas: 3 }\n';
const assets = {
  fetch: vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    try {
      return new Response(await readFile(new URL(`./public${path}`, import.meta.url)));
    } catch {
      return new Response('Not found', { status: 404 });
    }
  }),
};
const env = (success = true) => ({ ASSETS: assets, VALIDATE_LIMIT: { limit: vi.fn(async () => ({ success })) } });
const post = (body: string, contentType = 'application/json', path = '/api/validate', headers: Record<string, string> = {}) =>
  new Request(url + path, { method: 'POST', headers: { 'Content-Type': contentType, ...headers }, body });

describe('schema validator API', () => {
  it('validates JSON requests against the selected release', async () => {
    const response = await worker.fetch(post(JSON.stringify({ version: 'v1.31.2', manifest })), env());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      targetVersion: '1.31', release: 'v1.31.14', scannedResources: 1, invalid: 1,
      resources: [{ name: 'app', status: 'invalid', errors: [{ path: 'data.replicas', message: 'expected string, got integer 3', line: 4 }] }],
    });
  });

  it.each(['application/yaml', 'application/x-yaml', 'text/yaml', 'text/plain; charset=utf-8'])(
    'accepts raw manifests with %s and the version query parameter', async contentType => {
      const response = await worker.fetch(post(manifest.replace('replicas: 3', 'replicas: "3"'), contentType, '/api/validate?version=1.16'), env());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ targetVersion: '1.16', valid: 1, invalid: 0 });
    });

  it('rejects bad input with JSON errors', async () => {
    const cases: [Request, number][] = [
      [post(JSON.stringify({ version: '1.15', manifest })), 400],
      [post(JSON.stringify({ version: '1.30', manifest: ' ' })), 400],
      [post(manifest, 'application/yaml'), 400],
      [post('{', 'application/json'), 400],
      [post(manifest, 'application/xml'), 415],
      [post(JSON.stringify({ version: '1.30', manifest }), 'application/json', '/api/validate', { Origin: 'https://evil.example' }), 403],
      [post('x'.repeat(3 * 1024 * 1024), 'application/yaml', '/api/validate?version=1.30'), 413],
      [new Request(`${url}/api/validate`), 405],
      [new Request(`${url}/api/nothing`), 404],
    ];
    for (const [request, status] of cases) {
      const response = await worker.fetch(request, env());
      expect(response.status, request.url).toBe(status);
      expect(await response.json()).toHaveProperty('error');
    }
  });

  it('rate limits validation requests', async () => {
    const response = await worker.fetch(post(JSON.stringify({ version: '1.30', manifest })), env(false));
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
  });

  it('returns a bounded error when a manifest needs to be split into smaller batches', async () => {
    const batch = Array.from({ length: 501 }, (_, i) => manifest.replace('name: app', `name: app-${i}`)).join('---\n');
    const response = await worker.fetch(post(batch, 'application/yaml', '/api/validate?version=1.30'), env());
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('500 documents') });
  });

  it('serves the supported version range', async () => {
    const response = await worker.fetch(new Request(`${url}/api/config`), env());
    expect(await response.json()).toEqual({ minimumMinor: 16, latestMinor: 37 });
  });
});
