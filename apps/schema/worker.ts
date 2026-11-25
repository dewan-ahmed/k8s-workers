import { latestMinor, minimumMinor } from '@k8s-workers/k8s-data';
import { appendCartoonTheme, appendSiteFooter, cartoonStylesheet } from '@k8s-workers/ui';
import { InputError, maxInputBytes, validateManifest, type SchemaSet } from './checker';

interface Env {
  ASSETS: Pick<Fetcher, 'fetch'>;
  VALIDATE_LIMIT: RateLimit;
}

const maxRequestBytes = maxInputBytes + 64 * 1024;
const rawContentTypes = new Set(['application/yaml', 'application/x-yaml', 'text/yaml', 'text/plain']);
const schemaCache = new Map<number, Promise<SchemaSet>>();
const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

function targetMinor(value: unknown) {
  const minor = typeof value === 'string' ? Number(/^v?1\.(\d{1,2})(?:\.\d{1,3})?$/.exec(value)?.[1]) : NaN;
  if (!Number.isInteger(minor) || minor < minimumMinor || minor > latestMinor) {
    throw new InputError(`Choose a Kubernetes version from 1.${minimumMinor} through 1.${latestMinor}.`);
  }
  return minor;
}

async function boundedText(request: Request) {
  if (Number(request.headers.get('Content-Length')) > maxRequestBytes) throw new InputError('Request is too large.', 413);
  if (!request.body) throw new InputError('Request body is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    bytes += read.value.byteLength;
    if (bytes > maxRequestBytes) {
      await reader.cancel();
      throw new InputError('Request is too large.', 413);
    }
    chunks.push(read.value);
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

async function readInput(request: Request, url: URL) {
  const contentType = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (contentType && rawContentTypes.has(contentType)) {
    const version = url.searchParams.get('version');
    if (!version) throw new InputError('Add the version query parameter for raw manifests (for example, ?version=1.30).');
    return { version, manifest: await boundedText(request) };
  }
  if (contentType !== 'application/json') {
    throw new InputError('Use application/json, or application/yaml, application/x-yaml, text/yaml, or text/plain for raw manifests.', 415);
  }
  const body = await boundedText(request);
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    throw new InputError('Request body is not valid JSON.');
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Send a JSON object with version and manifest.');
  const { version, manifest } = input as Record<string, unknown>;
  return { version, manifest };
}

function loadSchemas(env: Env, origin: string, minor: number) {
  let schemas = schemaCache.get(minor);
  if (!schemas) {
    schemas = env.ASSETS.fetch(new Request(`${origin}/schemas/1.${minor}.json`)).then(response => {
      if (!response.ok) throw new Error(`Schema for 1.${minor} is unavailable.`);
      return response.json<SchemaSet>();
    });
    schemas.catch(() => schemaCache.delete(minor));
    schemaCache.set(minor, schemas);
  }
  return schemas;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/cartoon.css') return cartoonStylesheet();
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const asset = await env.ASSETS.fetch(request);
      return request.method === 'GET' && asset.ok ? appendCartoonTheme(appendSiteFooter(asset), 'schema') : asset;
    }
    if (url.pathname === '/api/config') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405, { Allow: 'GET' });
      return json({ minimumMinor, latestMinor });
    }
    if (url.pathname !== '/api/validate') return json({ error: 'Not found.' }, 404);
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, { Allow: 'POST' });
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return json({ error: 'Cross-origin requests are not allowed.' }, 403);

    try {
      const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
      if (!(await env.VALIDATE_LIMIT.limit({ key: `ip:${ip}` })).success) {
        return json({ error: 'Too many requests. Try again in a minute.' }, 429, { 'Retry-After': '60' });
      }
      const input = await readInput(request, url);
      const minor = targetMinor(input.version);
      if (typeof input.manifest !== 'string' || !input.manifest.trim()) throw new InputError('Paste a Kubernetes manifest to validate.');
      if (new TextEncoder().encode(input.manifest).length > maxInputBytes) throw new InputError('Manifest exceeds 2 MiB.', 413);
      return json(await validateManifest(input.manifest, minor, await loadSchemas(env, url.origin, minor)));
    } catch (error) {
      if (error instanceof InputError) return json({ error: error.message }, error.status);
      return json({ error: 'The manifest could not be validated.' }, 500);
    }
  },
};
