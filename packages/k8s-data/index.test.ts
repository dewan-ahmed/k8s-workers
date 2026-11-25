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

  it('recommends only replacements available in the target release', () => {
    expect(findDeprecation('extensions/v1beta1', 'Ingress', 18)?.replacement?.apiVersion).toBe('networking.k8s.io/v1beta1');
    expect(findDeprecation('extensions/v1beta1', 'Ingress', 19)?.replacement?.apiVersion).toBe('networking.k8s.io/v1');
    expect(findDeprecation('autoscaling/v2beta1', 'HorizontalPodAutoscaler', 22)?.replacement?.apiVersion).toBe('autoscaling/v2beta2');
    expect(findDeprecation('autoscaling/v2beta1', 'HorizontalPodAutoscaler', 23)?.replacement?.apiVersion).toBe('autoscaling/v2');
    expect(findDeprecation('storage.k8s.io/v1alpha1', 'CSIStorageCapacity', 23)?.replacement?.apiVersion).toBe('storage.k8s.io/v1beta1');
    expect(findDeprecation('storage.k8s.io/v1alpha1', 'CSIStorageCapacity', 24)?.replacement?.apiVersion).toBe('storage.k8s.io/v1');
    expect(findDeprecation('storage.k8s.io/v1alpha1', 'VolumeAttachment', 23)?.replacement?.apiVersion).toBe('storage.k8s.io/v1');
  });

  it('covers all migration guide entries and upstream lifecycle additions', () => {
    expect(findDeprecation('apps/v1beta1', 'ReplicaSet', 16)).toMatchObject({
      status: 'removed', removedIn: 16, replacement: { apiVersion: 'apps/v1', kind: 'ReplicaSet' },
    });
    expect(findDeprecation('admission.k8s.io/v1beta1', 'AdmissionReview', 22)).toMatchObject({
      status: 'removed', removedIn: 22, replacement: { apiVersion: 'admission.k8s.io/v1', kind: 'AdmissionReview' },
    });
    expect(findDeprecation('flowcontrol.apiserver.k8s.io/v1beta1', 'PriorityLevelConfiguration', 29)?.notes)
      .toContain('nominalConcurrencyShares');
    expect(findDeprecation('extensions/v1beta1', 'DaemonSet', 16)?.notes).toContain('spec.templateGeneration');
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
