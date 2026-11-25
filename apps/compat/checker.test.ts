import { describe, expect, it } from 'vitest';
import { checkCompatibility } from './checker';

describe('cluster compatibility', () => {
  it('uses upstream lifecycle rules for removals and checks known stable API introductions', () => {
    const inventory = 'batch/v1beta1 CronJob\nbatch/v1 CronJob\nexample.com/v1 Widget\nexample.com';
    expect(checkCompatibility({ targetVersion: '1.20', inventory }).apis.map(api => api.status))
      .toEqual(['unknown', 'unavailable', 'unknown', 'unknown']);
    expect(checkCompatibility({ targetVersion: '1.24', inventory }).apis.map(api => api.status))
      .toEqual(['deprecated', 'available', 'unknown', 'unknown']);
    expect(checkCompatibility({ targetVersion: '1.25', inventory }).apis[0]).toMatchObject({
      status: 'removed', replacement: { apiVersion: 'batch/v1', kind: 'CronJob' },
    });
  });

  it('checks the component skew boundaries against the target API server', () => {
    const inventory = [
      'kubectl v1.28.2', 'kubectl 1.26', 'kubectl 1.29', 'kubelet 1.24',
      'kubelet 1.28', 'kube-proxy 1.24', 'kube-scheduler 1.26', 'cloud-controller-manager 1.25',
    ].join('\n');
    expect(checkCompatibility({ targetVersion: '1.27', inventory }).components.map(item => item.supported))
      .toEqual([true, true, false, false, false, false, true, false]);
    expect(checkCompatibility({
      targetVersion: '1.28', inventory: 'kubelet 1.25\nkube-proxy 1.25\nkube-controller-manager 1.28',
    }).components.map(item => item.supported)).toEqual([true, true, true]);
  });

  it('reports sequential upgrade steps and does not present a downgrade as an upgrade', () => {
    expect(checkCompatibility({ currentVersion: '1.32', targetVersion: '1.35' }).upgrade)
      .toEqual({ status: 'upgrade', steps: ['1.32', '1.33', '1.34', '1.35'] });
    expect(checkCompatibility({ currentVersion: '1.35', targetVersion: '1.35' }).upgrade.status).toBe('same-minor');
    expect(checkCompatibility({ currentVersion: '1.36', targetVersion: '1.35' }).upgrade.status).toBe('downgrade');
    expect(checkCompatibility({ targetVersion: '1.35' }).upgrade.status).toBe('not-provided');
  });

  it('uses the published maintenance and EOL dates', () => {
    const input = { targetVersion: '1.35' };
    expect(checkCompatibility(input, '2026-12-27').release.status).toBe('supported');
    expect(checkCompatibility(input, '2026-12-28').release.status).toBe('maintenance');
    expect(checkCompatibility(input, '2027-02-28').release).toMatchObject({ status: 'eol', endOfLife: '2027-02-28' });
  });

  it('checks manifest lists and inventory together, warning about invalid input without expanding aliases', () => {
    const manifest = [
      'apiVersion: v1', 'kind: List', 'items:', '  - &pod {apiVersion: v1, kind: Pod}', '  - *pod', '---',
      'apiVersion: [broken', '---', '{apiVersion: policy/v1beta1, kind: PodSecurityPolicy}',
    ].join('\n');
    const result = checkCompatibility({ targetVersion: '1.25', manifest, inventory: 'kubectl 1.25\nkubelet nope' });
    expect(result.apis).toMatchObject([
      { kind: 'Pod', status: 'available', location: 'Manifest document 1, line 4' },
      { kind: 'PodSecurityPolicy', status: 'removed', location: 'Manifest document 3, line 9' },
    ]);
    expect(result.components).toHaveLength(1);
    expect(result.warnings).toEqual([
      expect.stringContaining('skipped entry'), expect.stringContaining('skipped invalid YAML'),
      expect.stringContaining('enter a Kubernetes component version'),
    ]);
  });
});
