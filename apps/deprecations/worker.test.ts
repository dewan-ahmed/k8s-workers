import { describe, expect, it, vi } from 'vitest';
import worker from './worker';

const manifest = 'apiVersion: batch/v1beta1\nkind: CronJob\nmetadata: {name: internal-job}';
const url = 'https://deprecations.k8s.workers.dev';
const send = vi.fn(async () => ({ messageId: 'simulated' }));
const binding = (success = true) => ({ limit: vi.fn(async () => ({ success })) });
const env = () => ({
  ASSETS: { fetch: vi.fn() },
  EMAIL: { send }, EMAIL_FROM: 'reports@example.com', SCAN_LIMIT: binding(), EMAIL_LIMIT: binding(),
});
const request = (path: string, data: object, headers: Record<string, string> = {}) => new Request(url + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(data),
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

  it('rejects cross-origin browser requests and disables email without a sender', async () => {
    const input = { manifest, targetVersion: '1.25', to: 'dev@example.com' };
    expect((await worker.fetch(request('/api/email', input, { Origin: 'https://elsewhere.test' }), env())).status).toBe(403);
    expect((await worker.fetch(request('/api/email', input), { ...env(), EMAIL_FROM: undefined })).status).toBe(503);
  });
});
