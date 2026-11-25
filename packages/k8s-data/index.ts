export const minimumMinor = 16;
export const latestMinor = 37;

export const migrationGuide = 'https://kubernetes.io/docs/reference/using-api/deprecation-guide/';
const lifecycleSource = 'https://github.com/kubernetes/api/tree/v0.37.2';

export interface ApiLifecycle {
  deprecatedIn: number;
  removedIn: number | null;
  replacement: { apiVersion: string; kind: string } | null;
  notes: string;
  sourceUrl: string;
}

type Rule = [
  apiVersion: string, kinds: string, deprecatedIn: number, removedIn: number | null,
  replacement: string | null, notes: string, source: string, replacementKind?: string,
];

const guide = (anchor: string) => `${migrationGuide}#${anchor}`;
const apiSource = (path: string) => `${lifecycleSource}/${path}/zz_generated.prerelease-lifecycle.go`;
const unchanged = 'Update the API version; the migration guide lists no notable schema changes.';
const validate = 'Update the API version and validate the resource against the replacement schema.';
const noSelector = 'Set spec.selector to the existing pod labels. The selector is required and immutable.';
const deployment = `${noSelector} Drop spec.rollbackTo and check rollout and history defaults.`;
const updateStrategy = `${noSelector} Check the default update strategy for your workload.`;
const hpa = 'Move targetAverageUtilization to target.averageUtilization and set target.type to Utilization.';
const psp = 'There is no direct replacement. Migrate to Pod Security Admission or a third-party admission webhook.';
const ingress = 'Rename spec.backend to spec.defaultBackend. Replace serviceName and servicePort with service.name and service.port.name or .number. Set pathType on each path.';
const flow = 'Rename spec.limited.assuredConcurrencyShares to nominalConcurrencyShares. An explicit zero no longer defaults to 30 in v1.';
const admission = 'Set sideEffects and admissionReviewVersions, ensure webhook names are unique, and check the v1 failurePolicy, matchPolicy, and timeoutSeconds defaults.';
const dra = 'Use the stable Dynamic Resource Allocation API and validate device constraints, requests, and selectors against its schema.';

const rules: Rule[] = [
  ['extensions/v1beta1', 'DaemonSet', 8, 16, 'apps/v1', updateStrategy, guide('daemonset-v116')],
  ['extensions/v1beta1', 'Deployment', 8, 16, 'apps/v1', deployment, guide('deployment-v116')],
  ['extensions/v1beta1', 'ReplicaSet', 8, 16, 'apps/v1', noSelector, guide('replicaset-v116')],
  ['extensions/v1beta1', 'NetworkPolicy', 9, 16, 'networking.k8s.io/v1', unchanged, guide('networkpolicy-v116')],
  ['extensions/v1beta1', 'PodSecurityPolicy', 10, 16, 'policy/v1beta1', 'For Kubernetes 1.16–1.24, move to policy/v1beta1. From 1.25, use Pod Security Admission or a third-party webhook.', guide('psp-v116')],
  ['apps/v1beta1', 'Deployment', 8, 16, 'apps/v1', deployment, guide('deployment-v116')],
  ['apps/v1beta1', 'StatefulSet', 8, 16, 'apps/v1', updateStrategy, guide('statefulset-v116')],
  ['apps/v1beta1', 'ControllerRevision', 8, 16, 'apps/v1', validate, apiSource('apps/v1beta1')],
  ['apps/v1beta2', 'DaemonSet', 9, 16, 'apps/v1', updateStrategy, guide('daemonset-v116')],
  ['apps/v1beta2', 'Deployment', 9, 16, 'apps/v1', deployment, guide('deployment-v116')],
  ['apps/v1beta2', 'StatefulSet', 9, 16, 'apps/v1', updateStrategy, guide('statefulset-v116')],
  ['apps/v1beta2', 'ReplicaSet', 9, 16, 'apps/v1', noSelector, guide('replicaset-v116')],
  ['apps/v1beta2', 'ControllerRevision', 9, 16, 'apps/v1', validate, apiSource('apps/v1beta2')],
  ['admissionregistration.k8s.io/v1beta1', 'MutatingWebhookConfiguration ValidatingWebhookConfiguration', 16, 22, 'admissionregistration.k8s.io/v1', admission, guide('webhook-resources-v122')],
  ['apiextensions.k8s.io/v1beta1', 'CustomResourceDefinition', 16, 22, 'apiextensions.k8s.io/v1', 'Set spec.scope, move spec.version to spec.versions and per-version schema, subresources, and columns into spec.versions[]. Supply a structural schema and update webhook conversion settings.', guide('customresourcedefinition-v122')],
  ['apiregistration.k8s.io/v1beta1', 'APIService', 19, 22, 'apiregistration.k8s.io/v1', unchanged, guide('apiservice-v122')],
  ['authentication.k8s.io/v1beta1', 'TokenReview', 19, 22, 'authentication.k8s.io/v1', unchanged, guide('tokenreview-v122')],
  ['authorization.k8s.io/v1beta1', 'LocalSubjectAccessReview SelfSubjectAccessReview SelfSubjectRulesReview SubjectAccessReview', 19, 22, 'authorization.k8s.io/v1', 'For SubjectAccessReview and LocalSubjectAccessReview, rename spec.group to spec.groups.', guide('subjectaccessreview-resources-v122')],
  ['certificates.k8s.io/v1beta1', 'CertificateSigningRequest', 19, 22, 'certificates.k8s.io/v1', 'Set spec.signerName and spec.usages. Do not use kubernetes.io/legacy-unknown. Review the v1 certificate and status condition requirements.', guide('certificatesigningrequest-v122')],
  ['coordination.k8s.io/v1beta1', 'Lease', 19, 22, 'coordination.k8s.io/v1', unchanged, guide('lease-v122')],
  ['extensions/v1beta1', 'Ingress', 14, 22, 'networking.k8s.io/v1', ingress, guide('ingress-v122')],
  ['networking.k8s.io/v1beta1', 'Ingress', 19, 22, 'networking.k8s.io/v1', ingress, guide('ingress-v122')],
  ['networking.k8s.io/v1beta1', 'IngressClass', 19, 22, 'networking.k8s.io/v1', unchanged, guide('ingressclass-v122')],
  ['rbac.authorization.k8s.io/v1beta1', 'ClusterRole ClusterRoleBinding Role RoleBinding', 17, 22, 'rbac.authorization.k8s.io/v1', unchanged, guide('rbac-resources-v122')],
  ['scheduling.k8s.io/v1beta1', 'PriorityClass', 14, 22, 'scheduling.k8s.io/v1', unchanged, guide('priorityclass-v122')],
  ['storage.k8s.io/v1beta1', 'CSIDriver StorageClass VolumeAttachment', 19, 22, 'storage.k8s.io/v1', unchanged, guide('storage-resources-v122')],
  ['storage.k8s.io/v1beta1', 'CSINode', 17, 22, 'storage.k8s.io/v1', unchanged, guide('storage-resources-v122')],
  ['batch/v1beta1', 'CronJob', 21, 25, 'batch/v1', unchanged, guide('cronjob-v125')],
  ['discovery.k8s.io/v1beta1', 'EndpointSlice', 21, 25, 'discovery.k8s.io/v1', 'Move topology hostname and zone to nodeName and zone on each endpoint. deprecatedTopology is read-only.', guide('endpointslice-v125')],
  ['events.k8s.io/v1beta1', 'Event', 22, 25, 'events.k8s.io/v1', 'Use regarding, eventTime, and series in place of involvedObject and legacy timestamps and counts. Set action, reason, reportingController and reportingInstance.', guide('event-v125')],
  ['autoscaling/v2beta1', 'HorizontalPodAutoscaler', 22, 25, 'autoscaling/v2', hpa, guide('horizontalpodautoscaler-v125')],
  ['policy/v1beta1', 'PodDisruptionBudget', 21, 25, 'policy/v1', 'An empty selector ({}) selects all pods in v1, not zero. An unset selector still selects no pods.', guide('poddisruptionbudget-v125')],
  ['policy/v1beta1', 'PodSecurityPolicy', 21, 25, null, psp, guide('psp-v125')],
  ['policy/v1beta1', 'Eviction', 22, 25, 'policy/v1', 'Update eviction clients to use policy/v1.', apiSource('policy/v1beta1')],
  ['node.k8s.io/v1beta1', 'RuntimeClass', 22, 25, 'node.k8s.io/v1', unchanged, guide('runtimeclass-v125')],
  ['autoscaling/v2beta2', 'HorizontalPodAutoscaler', 23, 26, 'autoscaling/v2', hpa, guide('horizontalpodautoscaler-v126')],
  ['flowcontrol.apiserver.k8s.io/v1beta1', 'FlowSchema PriorityLevelConfiguration', 23, 26, 'flowcontrol.apiserver.k8s.io/v1', 'Use v1 from 1.29. For 1.23–1.25 use v1beta2; for 1.26–1.28 use v1beta3.', guide('flowcontrol-resources-v126')],
  ['storage.k8s.io/v1beta1', 'CSIStorageCapacity', 24, 27, 'storage.k8s.io/v1', unchanged, guide('csistoragecapacity-v127')],
  ['flowcontrol.apiserver.k8s.io/v1beta2', 'FlowSchema', 26, 29, 'flowcontrol.apiserver.k8s.io/v1', 'Use v1 from Kubernetes 1.29; v1beta3 is available from 1.26 through 1.31.', guide('flowcontrol-resources-v129')],
  ['flowcontrol.apiserver.k8s.io/v1beta2', 'PriorityLevelConfiguration', 26, 29, 'flowcontrol.apiserver.k8s.io/v1', `Use v1 from 1.29. ${flow}`, guide('flowcontrol-resources-v129')],
  ['flowcontrol.apiserver.k8s.io/v1beta3', 'FlowSchema', 29, 32, 'flowcontrol.apiserver.k8s.io/v1', unchanged, guide('flowcontrol-resources-v132')],
  ['flowcontrol.apiserver.k8s.io/v1beta3', 'PriorityLevelConfiguration', 29, 32, 'flowcontrol.apiserver.k8s.io/v1', 'In spec.limited.nominalConcurrencyShares, an explicit zero is no longer defaulted to 30.', guide('flowcontrol-resources-v132')],
  ['authentication.k8s.io/v1alpha1', 'SelfSubjectReview', 29, 32, 'authentication.k8s.io/v1', validate, apiSource('authentication/v1alpha1')],
  ['authentication.k8s.io/v1beta1', 'SelfSubjectReview', 30, 33, 'authentication.k8s.io/v1', validate, apiSource('authentication/v1beta1')],
  ['admissionregistration.k8s.io/v1alpha1', 'ValidatingAdmissionPolicy ValidatingAdmissionPolicyBinding', 29, 32, 'admissionregistration.k8s.io/v1', 'Use v1 from 1.30 and validate CEL expressions and policy bindings.', apiSource('admissionregistration/v1alpha1')],
  ['admissionregistration.k8s.io/v1beta1', 'ValidatingAdmissionPolicy ValidatingAdmissionPolicyBinding', 31, 34, 'admissionregistration.k8s.io/v1', validate, apiSource('admissionregistration/v1beta1')],
  ['apidiscovery.k8s.io/v2beta1', 'APIGroupDiscovery', 32, 35, 'apidiscovery.k8s.io/v2', 'Update the API version in discovery clients.', apiSource('apidiscovery/v2beta1')],
  ['v1', 'Endpoints', 33, null, 'discovery.k8s.io/v1', 'Use EndpointSlice. Consumers must aggregate all slices for a Service and handle endpoint conditions.', 'https://kubernetes.io/blog/2025/04/24/endpoints-deprecation/', 'EndpointSlice'],
  ['storage.k8s.io/v1alpha1', 'VolumeAttributesClass', 32, 35, 'storage.k8s.io/v1', 'Use the stable API from 1.34; on 1.32–1.33 use storage.k8s.io/v1beta1.', apiSource('storage/v1alpha1')],
  ['storage.k8s.io/v1beta1', 'VolumeAttributesClass', 34, 37, 'storage.k8s.io/v1', validate, apiSource('storage/v1beta1')],
  ['networking.k8s.io/v1beta1', 'IPAddress ServiceCIDR', 34, 37, 'networking.k8s.io/v1', validate, apiSource('networking/v1beta1')],
  ['certificates.k8s.io/v1alpha1', 'ClusterTrustBundle', 34, 37, 'certificates.k8s.io/v1', 'Use v1beta1 until the stable v1 API is available in 1.37.', apiSource('certificates/v1alpha1')],
  ['certificates.k8s.io/v1beta1', 'ClusterTrustBundle', 37, 40, 'certificates.k8s.io/v1', validate, apiSource('certificates/v1beta1')],
  ['certificates.k8s.io/v1beta1', 'PodCertificateRequest', 37, 40, 'certificates.k8s.io/v1', 'Use v1 and stop setting PKIXPublicKey and ProofOfPossession.', apiSource('certificates/v1beta1')],
  ['resource.k8s.io/v1beta1', 'DeviceClass ResourceClaim ResourceClaimTemplate ResourceSlice', 35, 38, 'resource.k8s.io/v1', dra, apiSource('resource/v1beta1')],
  ['resource.k8s.io/v1beta2', 'DeviceClass ResourceClaim ResourceClaimTemplate ResourceSlice', 36, 39, 'resource.k8s.io/v1', dra, apiSource('resource/v1beta2')],
  ['resource.k8s.io/v1alpha3', 'DeviceTaintRule', 36, 39, 'resource.k8s.io/v1beta2', validate, apiSource('resource/v1alpha3')],
  ['admissionregistration.k8s.io/v1alpha1', 'MutatingAdmissionPolicy MutatingAdmissionPolicyBinding', 35, 38, 'admissionregistration.k8s.io/v1', 'Use v1beta1 on 1.35; use stable v1 from 1.36.', apiSource('admissionregistration/v1alpha1')],
  ['admissionregistration.k8s.io/v1beta1', 'MutatingAdmissionPolicy MutatingAdmissionPolicyBinding', 37, 40, 'admissionregistration.k8s.io/v1', validate, apiSource('admissionregistration/v1beta1')],
  ['coordination.k8s.io/v1alpha2', 'LeaseCandidate', 35, 38, 'coordination.k8s.io/v1beta1', 'Use v1beta1 where served; check the supported versions on your cluster.', apiSource('coordination/v1alpha2')],
  ['coordination.k8s.io/v1beta1', 'LeaseCandidate', 36, 39, null, 'No stable replacement is listed in the upstream API lifecycle metadata. Check the supported versions before upgrading.', apiSource('coordination/v1beta1')],
  ['storagemigration.k8s.io/v1beta1', 'StorageVersionMigration', 37, 40, 'storagemigration.k8s.io/v1', validate, apiSource('storagemigration/v1beta1')],
];

const key = (apiVersion: string, kind: string) => `${apiVersion}:${kind}`;
const earlierReplacements: Record<string, [until: number, apiVersion: string][]> = {
  'flowcontrol.apiserver.k8s.io/v1beta1': [[26, 'flowcontrol.apiserver.k8s.io/v1beta2'], [29, 'flowcontrol.apiserver.k8s.io/v1beta3']],
  'flowcontrol.apiserver.k8s.io/v1beta2': [[29, 'flowcontrol.apiserver.k8s.io/v1beta3']],
  'storage.k8s.io/v1alpha1': [[34, 'storage.k8s.io/v1beta1']],
  'certificates.k8s.io/v1alpha1': [[37, 'certificates.k8s.io/v1beta1']],
};
export const apiLifecycle: ReadonlyMap<string, ApiLifecycle> = new Map(rules.flatMap(
  ([apiVersion, kinds, deprecatedIn, removedIn, replacement, notes, source, replacementKind]) =>
    kinds.split(' ').map(kind => [key(apiVersion, kind), {
      deprecatedIn, removedIn, notes, sourceUrl: source,
      replacement: replacement ? { apiVersion: replacement, kind: replacementKind ?? kind } : null,
    }] as const),
));

export function findDeprecation(apiVersion: string, kind: string, targetMinor: number) {
  const rule = apiLifecycle.get(key(apiVersion, kind));
  if (!rule || targetMinor < rule.deprecatedIn) return null;

  const earlier = earlierReplacements[apiVersion]?.find(([until]) => targetMinor < until)?.[1]
    ?? (apiVersion === 'admissionregistration.k8s.io/v1alpha1' && targetMinor < (kind.startsWith('Mutating') ? 36 : 30)
      ? 'admissionregistration.k8s.io/v1beta1' : undefined);
  let replacement = earlier && rule.replacement ? { ...rule.replacement, apiVersion: earlier } : rule.replacement;
  const seen = new Set<string>();
  while (replacement) {
    const nextKey = key(replacement.apiVersion, replacement.kind);
    const next = apiLifecycle.get(nextKey);
    if (!next?.removedIn || next.removedIn > targetMinor || seen.has(nextKey)) break;
    seen.add(nextKey);
    replacement = next.replacement;
  }
  return {
    ...rule,
    replacement,
    status: rule.removedIn !== null && targetMinor >= rule.removedIn ? 'removed' as const : 'deprecated' as const,
  };
}
