import { describe, expect, it } from 'vitest';
import { findDeprecation } from './index';

describe('Kubernetes API lifecycle', () => {
  it('matches apiVersion and kind and uses inclusive numeric release boundaries', () => {
    expect(findDeprecation('batch/v1beta1', 'Job', 25)).toBeNull();
    expect(findDeprecation('batch/v1beta1', 'CronJob', 20)).toBeNull();
    expect(findDeprecation('batch/v1beta1', 'CronJob', 21)).toMatchObject({ status: 'deprecated', removedIn: 25 });
    expect(findDeprecation('batch/v1beta1', 'CronJob', 25)).toMatchObject({
      status: 'removed', replacement: { apiVersion: 'batch/v1', kind: 'CronJob' },
    });
  });

  it('does not claim a direct replacement or recommend one removed by the target', () => {
    expect(findDeprecation('extensions/v1beta1', 'PodSecurityPolicy', 24)?.replacement?.apiVersion).toBe('policy/v1beta1');
    expect(findDeprecation('extensions/v1beta1', 'PodSecurityPolicy', 25)?.replacement).toBeNull();
    expect(findDeprecation('flowcontrol.apiserver.k8s.io/v1beta2', 'FlowSchema', 27)?.replacement?.apiVersion).toBe('flowcontrol.apiserver.k8s.io/v1beta3');
    expect(findDeprecation('flowcontrol.apiserver.k8s.io/v1beta1', 'FlowSchema', 29)?.replacement?.apiVersion).toBe('flowcontrol.apiserver.k8s.io/v1');
  });

  it('covers recent removals and a deprecated stable API with no scheduled removal', () => {
    expect(findDeprecation('v1', 'Endpoints', 37)).toMatchObject({
      status: 'deprecated', deprecatedIn: 33, removedIn: null,
      replacement: { apiVersion: 'discovery.k8s.io/v1', kind: 'EndpointSlice' },
    });
    expect(findDeprecation('storage.k8s.io/v1alpha1', 'VolumeAttributesClass', 35)?.status).toBe('removed');
    expect(findDeprecation('networking.k8s.io/v1beta1', 'ServiceCIDR', 37)?.status).toBe('removed');
  });
});
