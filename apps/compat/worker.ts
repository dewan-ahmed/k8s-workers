import { latestMinor, minimumMinor } from '@k8s-workers/k8s-data';
import { appendSiteFooter } from '@k8s-workers/ui';
import { checkCompatibility, maxRequestBytes } from './checker';
import { InputError } from './manifest';

interface Env {
  ASSETS: Pick<Fetcher, 'fetch'>;
  CHECK_LIMIT: RateLimit;
}

const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

async function readInput(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('Content-Length')) > maxRequestBytes) {
    throw new InputError('Request is too large.', 413);
  }
  if (!request.body) throw new InputError('Request body is required.');
  let bytes = 0;
  const bounded = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > maxRequestBytes) throw new InputError('Request is too large.', 413);
      controller.enqueue(chunk);
    },
  }));
  let body: unknown;
  try {
    body = await new Response(bounded).json();
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError('Send a valid JSON object.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InputError('Send a valid JSON object.');
  }
  return body as Record<string, unknown>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const asset = await env.ASSETS.fetch(request);
      return request.method === 'GET' && asset.ok ? appendSiteFooter(asset) : asset;
    }
    const config = url.pathname === '/api/config';
    if (!config && url.pathname !== '/api/check') return json({ error: 'Not found.' }, 404);
    const method = config ? 'GET' : 'POST';
    if (request.method !== method) return json({ error: 'Method not allowed.' }, 405, { Allow: method });
    if (config) return json({ minimumMinor, latestMinor });
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return json({ error: 'Cross-origin requests are not allowed.' }, 403);
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return json({ error: 'Use application/json.' }, 415);
    }
    try {
      const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
      if (!(await env.CHECK_LIMIT.limit({ key: `ip:${ip}` })).success) {
        return json({ error: 'Too many requests. Try again in a minute.' }, 429, { 'Retry-After': '60' });
      }
      return json(checkCompatibility(await readInput(request)));
    } catch (error) {
      if (error instanceof InputError) return json({ error: error.message }, error.status);
      return json({ error: 'The compatibility check could not be completed.' }, 500);
    }
  },
};
