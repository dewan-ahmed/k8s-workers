import { parseEmail, sendTextEmail, type EmailBinding } from '@k8s-workers/email';
import { latestMinor, migrationGuide, minimumMinor } from '@k8s-workers/k8s-data';
import { appendSiteFooter } from '@k8s-workers/ui';
import { InputError, makeReport, maxInputBytes, scanChart, scanManifest, type Report } from './scanner';

interface Env {
  ASSETS: Pick<Fetcher, 'fetch'>;
  EMAIL: EmailBinding;
  EMAIL_FROM?: string;
  SCAN_LIMIT: RateLimit;
  EMAIL_LIMIT: RateLimit;
}

interface CheckInput {
  targetVersion: unknown;
  manifest?: unknown;
  chart?: File;
  to?: unknown;
}

const maxRequestBytes = maxInputBytes + 64 * 1024;
const manifestContentTypes = new Set(['application/yaml', 'application/x-yaml', 'text/yaml', 'text/plain']);
const splitManifest = 'Split the YAML at document separators (---) and check each batch separately.';
const manifestRequestTooLarge = `Manifest request is too large. ${splitManifest}`;
const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const tooMany = () => json({ error: 'Too many requests. Try again in a minute.' }, 429, { 'Retry-After': '60' });

function targetMinor(value: unknown) {
  const minor = typeof value === 'string' ? Number(/^v?1\.(\d{1,2})(?:\.\d{1,3})?$/.exec(value)?.[1]) : NaN;
  if (!Number.isInteger(minor) || minor < minimumMinor || minor > latestMinor) {
    throw new InputError(`Choose a target version from 1.${minimumMinor} through 1.${latestMinor}.`);
  }
  return minor;
}

async function boundedBody(request: Request, tooLarge: string) {
  if (Number(request.headers.get('Content-Length')) > maxRequestBytes) {
    throw new InputError(tooLarge, 413);
  }
  if (!request.body) throw new InputError('Request body is required.');
  let bytes = 0;
  return new Response(request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > maxRequestBytes) throw new InputError(tooLarge, 413);
      controller.enqueue(chunk);
    },
  })), { headers: { 'Content-Type': request.headers.get('Content-Type') ?? '' } });
}

async function readInput(request: Request, url: URL): Promise<CheckInput> {
  const contentType = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  const check = url.pathname === '/api/check';
  const raw = check && contentType !== undefined && manifestContentTypes.has(contentType);
  if (!raw && contentType !== 'application/json' && contentType !== 'multipart/form-data') {
    throw new InputError(check
      ? 'Use application/yaml, application/x-yaml, text/yaml, text/plain, or application/json for manifests, or multipart/form-data for charts.'
      : 'Use application/json for manifests or multipart/form-data for charts.', 415);
  }
  try {
    if (raw) {
      const targetVersion = url.searchParams.get('targetVersion');
      if (!targetVersion) throw new InputError('Add the targetVersion query parameter for raw manifests (for example, ?targetVersion=1.25).');
      return { targetVersion, manifest: await (await boundedBody(request, manifestRequestTooLarge)).text() };
    }
    const body = await boundedBody(request, contentType === 'application/json'
      ? manifestRequestTooLarge : 'Request is too large.');
    if (contentType === 'application/json') {
      const input: unknown = await body.json();
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        throw new InputError('Send a JSON object with targetVersion and manifest.');
      }
      const { targetVersion, manifest, to } = input as Record<string, unknown>;
      return { targetVersion, manifest, to };
    }
    const fields = await body.formData();
    const chart = fields.get('chart');
    if (!(chart instanceof File) || !/\.tgz$/i.test(chart.name)) {
      throw new InputError('Upload a Helm .tgz file in the chart field.');
    }
    return { chart, targetVersion: fields.get('targetVersion'), to: fields.get('to') };
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError('Request body could not be decoded.');
  }
}

async function reportFor(input: CheckInput): Promise<Report> {
  const target = targetMinor(input.targetVersion);
  if (input.chart) return makeReport(await scanChart(input.chart), target, 'chart');
  const { manifest } = input;
  if (typeof manifest !== 'string' || !manifest.trim()) throw new InputError('Paste a Kubernetes manifest to check.');
  if (new TextEncoder().encode(manifest).length > maxInputBytes) {
    throw new InputError(`Manifest exceeds 2 MiB. ${splitManifest}`, 413);
  }
  return makeReport(scanManifest(manifest), target, 'manifest');
}

function reportEmail(report: Report) {
  const groups = new Map<string, { finding: Report['findings'][number]; count: number }>();
  for (const finding of report.findings) {
    const key = `${finding.apiVersion}:${finding.kind}`;
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { finding, count: 1 });
  }
  return [
    `Kubernetes ${report.targetVersion} API deprecation report`,
    `Scanned: ${report.scannedResources} • Removed: ${report.removed} • Deprecated: ${report.deprecated}`,
    report.mode === 'chart' ? 'This was a static Helm archive scan. Check helm template output for the values you deploy.' : '',
    report.warnings.length ? 'The scan had warnings; review them on the checker before upgrading.' : '',
    '',
    ...Array.from(groups.values(), ({ finding, count }) => {
      const replacement = finding.replacement ? `${finding.replacement.apiVersion} ${finding.replacement.kind}` : 'None';
      const removed = finding.removedIn === null ? 'no removal announced' : `removed in 1.${finding.removedIn}`;
      return `[${finding.status.toUpperCase()}] ${finding.apiVersion} ${finding.kind} (×${count})\nDeprecated in 1.${finding.deprecatedIn}; ${removed}.\nReplacement: ${replacement}\n${finding.notes}\n${finding.sourceUrl}\n`;
    }),
    `Official migration guide: ${migrationGuide}`,
  ].join('\n');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const asset = await env.ASSETS.fetch(request);
      return request.method === 'GET' && asset.ok ? appendSiteFooter(asset) : asset;
    }
    const sender = parseEmail(env.EMAIL_FROM);
    if (url.pathname === '/api/config' && request.method === 'GET') {
      return json({ minimumMinor, latestMinor, emailEnabled: Boolean(sender) });
    }
    const email = url.pathname === '/api/email';
    if (!email && url.pathname !== '/api/check' && url.pathname !== '/api/config') {
      return json({ error: 'Not found.' }, 404);
    }
    if (request.method !== 'POST' || url.pathname === '/api/config') {
      return json({ error: 'Method not allowed.' }, 405, { Allow: url.pathname === '/api/config' ? 'GET' : 'POST' });
    }
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return json({ error: 'Cross-origin requests are not allowed.' }, 403);
    if (email && !sender) return json({ error: 'Email sending is not configured.' }, 503);

    try {
      const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
      const limit = email ? env.EMAIL_LIMIT : env.SCAN_LIMIT;
      if (!(await limit.limit({ key: `ip:${ip}` })).success) return tooMany();
      const input = await readInput(request, url);
      const recipient = email ? parseEmail(input.to) : null;
      if (email && !recipient) return json({ error: 'Enter one valid recipient email address.' }, 400);

      const report = await reportFor(input);
      if (!email) return json(report);
      if (report.scannedResources === 0) return json({ error: 'There are no scanned resources to email.' }, 422);

      if (!(await env.EMAIL_LIMIT.limit({ key: `recipient:${recipient!.toLowerCase()}` })).success) return tooMany();
      try {
        await sendTextEmail(env.EMAIL, sender!, recipient!, `Kubernetes ${report.targetVersion} deprecation report`, reportEmail(report));
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        if (code === 'E_RECIPIENT_PLAN_RESTRICTED' || code === 'E_RECIPIENT_NOT_ALLOWED') {
          return json({ error: 'This recipient is not allowed. The Workers Free plan can only email verified destinations.' }, 422);
        }
        if (code === 'E_RATE_LIMIT_EXCEEDED') return tooMany();
        return json({ error: 'Cloudflare Email Service could not accept the report.' }, 502);
      }
      return json({ accepted: true });
    } catch (error) {
      if (error instanceof InputError) return json({ error: error.message }, error.status);
      return json({ error: 'The scan could not be completed.' }, 500);
    }
  },
};
