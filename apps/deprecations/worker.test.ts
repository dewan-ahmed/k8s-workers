import { describe, expect, it, vi } from 'vitest';
import worker from './worker';

const manifest = 'apiVersion: batch/v1beta1\nkind: CronJob\nmetadata: {name: internal-job}';
const url = 'https://deprecations.k8s.workers.dev';
const send = vi.fn(async () => ({ messageId: 'simulated' }));
const binding = (success = true) => ({ limit: vi.fn(async () => ({ success })) });
const env = () => ({
  ASSETS: { fetch: vi.fn() },
  EMAIL: { send }, EMAIL_FROM: 'reports@example.com', EMAIL_ALLOWED_RECIPIENTS: 'dev@example.com',
  SCAN_LIMIT: binding(), EMAIL_LIMIT: binding(),
});
const request = (path: string, data: object, headers: Record<string, string> = {}) => new Request(url + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(data),
});
const rawRequest = (path: string, body = manifest, contentType = 'application/yaml') => new Request(url + path, {
  method: 'POST',
  headers: { 'Content-Type': contentType },
  body,
});

describe('checker API', () => {
  it('returns lifecycle details and rejects unsupported targets', async () => {
    const response = await worker.fetch(request('/api/check', { manifest, targetVersion: 'v1.25.3' }), env());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      removed: 1, targetVersion: '1.25', findings: [{ name: 'internal-job', source: 'manifest' }],
    });
    const invalid = await worker.fetch(request('/api/check', { manifest, targetVersion: '2.1' }), env());
    expect(invalid.status).toBe(400);
  });

  it.each(['application/yaml', 'application/x-yaml', 'text/yaml', 'text/plain; charset=utf-8'])(
    'accepts raw manifests with %s and uses the query target', async contentType => {
      const response = await worker.fetch(rawRequest('/api/check?targetVersion=1.25', manifest, contentType), env());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        targetVersion: '1.25', mode: 'manifest', scannedResources: 1, removed: 1, warnings: [],
      });
    },
  );

  it('rejects missing or invalid raw manifest targets', async () => {
    const missing = await worker.fetch(rawRequest('/api/check'), env());
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: expect.stringContaining('?targetVersion=1.25') });
    const invalid = await worker.fetch(rawRequest('/api/check?targetVersion=2.1'), env());
    expect(invalid.status).toBe(400);
  });

  it('keeps manifest validation and scan warnings for raw bodies', async () => {
    const path = '/api/check?targetVersion=1.25';
    const empty = await worker.fetch(rawRequest(path, ' '), env());
    expect(empty.status).toBe(400);
    const oversized = await worker.fetch(rawRequest(path, 'x'.repeat(2 * 1024 * 1024 + 1)), env());
    expect(oversized.status).toBe(413);
    const invalid = await worker.fetch(rawRequest(path, 'apiVersion: [unterminated'), env());
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ error: expect.stringContaining('skipped invalid YAML') });
    const partial = await worker.fetch(rawRequest(path, `apiVersion: [unterminated\n---\n${manifest}`), env());
    expect(partial.status).toBe(200);
    expect(await partial.json()).toMatchObject({
      scannedResources: 1, warnings: [expect.stringContaining('document 1: skipped invalid YAML')],
    });
  });

  it('does not accept raw bodies for email', async () => {
    const response = await worker.fetch(rawRequest('/api/email?targetVersion=1.25'), env());
    expect(response.status).toBe(415);
  });

  it.each([
    ['Manifest exceeds 2 MiB.', 1],
    ['Manifest request is too large.', 128 * 1024],
  ])('suggests splitting oversized YAML: %s', async (message, extraBytes) => {
    const oversized = '#'.repeat(2 * 1024 * 1024 + extraBytes);
    for (const input of [
      request('/api/check', { manifest: oversized, targetVersion: '1.25' }),
      rawRequest('/api/check?targetVersion=1.25', oversized),
    ]) {
      const response = await worker.fetch(input, env());
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        error: `${message} Split the YAML at document separators (---) and check each batch separately.`,
      });
    }
  });

  it('only emails a server-generated summary and rate-limits repeat recipients', async () => {
    const emailEnv = env();
    const input = { manifest, targetVersion: '1.25', to: 'dev@example.com', text: 'arbitrary mail' };
    const result = await worker.fetch(request('/api/email', input), emailEnv);
    expect(result.status).toBe(200);
    expect(send).toHaveBeenCalledWith({
      from: 'reports@example.com', to: 'dev@example.com',
      subject: 'Kubernetes 1.25 deprecation report', text: expect.stringContaining('batch/v1beta1 CronJob'),
    });
    expect(send.mock.lastCall).not.toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('internal-job') })]));
    expect(send.mock.lastCall).not.toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('arbitrary mail') })]));
    expect(emailEnv.EMAIL_LIMIT.limit).toHaveBeenCalledWith({ key: 'recipient:dev@example.com' });

    emailEnv.EMAIL_LIMIT.limit.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });
    const limited = await worker.fetch(request('/api/email', input), emailEnv);
    expect(limited.status).toBe(429);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects cross-origin browser requests and requires a sender and an explicit recipient allowlist', async () => {
    const input = { manifest, targetVersion: '1.25', to: 'dev@example.com' };
    expect((await worker.fetch(request('/api/email', input, { Origin: 'https://elsewhere.test' }), env())).status).toBe(403);
    expect((await worker.fetch(request('/api/email', input), { ...env(), EMAIL_FROM: undefined })).status).toBe(503);
    const disabled = { ...env(), EMAIL_ALLOWED_RECIPIENTS: undefined };
    expect((await worker.fetch(request('/api/email', input), disabled)).status).toBe(503);
    const config = new Request(url + '/api/config');
    expect(await (await worker.fetch(config, disabled)).json()).toMatchObject({ emailEnabled: false });
    expect(await (await worker.fetch(config, env())).json()).toMatchObject({ emailEnabled: true });
  });

  it('does not send a report to an unapproved recipient', async () => {
    const send = vi.fn();
    const input = { manifest, targetVersion: '1.25', to: 'other@example.com' };
    const response = await worker.fetch(request('/api/email', input), { ...env(), EMAIL: { send } });
    expect(response.status).toBe(422);
    expect(send).not.toHaveBeenCalled();
  });
});
