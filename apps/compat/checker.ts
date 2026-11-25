import { apiLifecycle, findDeprecation, latestMinor, migrationGuide, minimumMinor } from '@k8s-workers/k8s-data';
import { apiIdentifier, InputError, kindIdentifier, readManifest, type Resource } from './manifest';
import { releaseStatus } from './releases';

export const skewPolicy = 'https://kubernetes.io/releases/version-skew-policy/';
export const maxRequestBytes = 512 * 1024;
const maxManifestBytes = 256 * 1024;
const maxInventoryBytes = 16 * 1024;
const components = new Set([
  'kubectl', 'kubelet', 'kube-proxy', 'kube-controller-manager', 'kube-scheduler', 'cloud-controller-manager',
]);

const stableSince = new Map([
  ['apps/v1:Deployment', 9], ['apps/v1:StatefulSet', 9], ['apps/v1:DaemonSet', 9],
  ['batch/v1:CronJob', 21], ['networking.k8s.io/v1:Ingress', 19],
  ['networking.k8s.io/v1:IngressClass', 19], ['networking.k8s.io/v1:NetworkPolicy', 8],
  ['apiextensions.k8s.io/v1:CustomResourceDefinition', 16], ['apiregistration.k8s.io/v1:APIService', 10],
  ['admissionregistration.k8s.io/v1:MutatingWebhookConfiguration', 16],
  ['admissionregistration.k8s.io/v1:ValidatingWebhookConfiguration', 16],
  ['certificates.k8s.io/v1:CertificateSigningRequest', 19], ['discovery.k8s.io/v1:EndpointSlice', 21],
  ['events.k8s.io/v1:Event', 19], ['policy/v1:PodDisruptionBudget', 21],
  ['autoscaling/v2:HorizontalPodAutoscaler', 23], ['flowcontrol.apiserver.k8s.io/v1:FlowSchema', 29],
  ['flowcontrol.apiserver.k8s.io/v1:PriorityLevelConfiguration', 29],
]);
const coreKinds = new Set([
  'ConfigMap', 'Endpoints', 'LimitRange', 'Namespace', 'Node', 'PersistentVolume',
  'PersistentVolumeClaim', 'Pod', 'ReplicationController', 'ResourceQuota', 'Secret', 'Service', 'ServiceAccount',
]);
const version = (minor: number) => `1.${minor}`;
const parseMinor = (value: unknown) => typeof value === 'string'
  ? Number(/^v?1\.(0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,4}))?$/.exec(value)?.[1]) : NaN;

function clusterMinor(value: unknown, label: string, min = minimumMinor) {
  const minor = parseMinor(value);
  if (!Number.isInteger(minor) || minor < min || minor > latestMinor) {
    throw new InputError(`Choose a ${label} version from ${version(min)} through ${version(latestMinor)}.`);
  }
  return minor;
}

function textInput(value: unknown, label: string, maxBytes: number) {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new InputError(`${label} must be text.`);
  if (new TextEncoder().encode(value).length > maxBytes) throw new InputError(`${label} exceeds ${maxBytes / 1024} KiB.`, 413);
  return value.trim() ? value : '';
}

function checkApi(resource: Resource, target: number) {
  const { apiVersion, kind } = resource;
  const key = `${apiVersion}:${kind}`;
  const lifecycle = kind ? findDeprecation(apiVersion, kind, target) : null;
  if (lifecycle) {
    const message = lifecycle.status === 'removed'
      ? `Removed in ${version(lifecycle.removedIn!)}. ${lifecycle.notes}`
      : `Deprecated since ${version(lifecycle.deprecatedIn)}.${lifecycle.removedIn ? ` Removal in ${version(lifecycle.removedIn)}.` : ''} ${lifecycle.notes}`;
    return { ...resource, status: lifecycle.status, message, replacement: lifecycle.replacement, sourceUrl: lifecycle.sourceUrl };
  }

  const introduced = stableSince.get(key);
  if (introduced && target < introduced) {
    return { ...resource, status: 'unavailable', message: `This API version was introduced in ${version(introduced)}.`, sourceUrl: migrationGuide };
  }
  if (introduced || (apiVersion === 'v1' && kind && coreKinds.has(kind))) {
    return { ...resource, status: 'available', message: 'Available in the upstream Kubernetes API.' };
  }
  if (apiLifecycle.has(key)) {
    return { ...resource, status: 'unknown', message: 'No removal is recorded for this target; the lifecycle data does not confirm availability.' };
  }
  return {
    ...resource, status: 'unknown',
    message: kind ? 'Not covered by the upstream API data. Confirm availability on the target cluster.'
      : 'A group or version alone cannot establish availability. Add the resource kind and full API version for a lifecycle check.',
  };
}

function readInventory(input: string, target: number) {
  const versions = [];
  const resources: Resource[] = [];
  const warnings = [];
  const lines = input.split(/\r?\n/);
  if (lines.length > 250) throw new InputError('Inventory exceeds 250 lines.', 413);
  for (const [index, line] of lines.entries()) {
    const entry = line.split('#', 1)[0].trim();
    if (!entry) continue;
    const location = `Inventory line ${index + 1}`;
    const [first, second, ...rest] = entry.split(/\s+/);
    if (components.has(first) && !rest.length) {
      const minor = parseMinor(second);
      if (!Number.isInteger(minor)) {
        warnings.push(`${location}: enter a Kubernetes component version such as 1.36.0.`);
        continue;
      }
      const maxOlder = first === 'kubelet' || first === 'kube-proxy' ? minor < 25 ? 2 : 3 : 1;
      const maxNewer = first === 'kubectl' ? 1 : 0;
      const supported = target - minor <= maxOlder && minor - target <= maxNewer;
      const rule = maxNewer ? 'must be within one minor of'
        : `must not be newer than or more than ${maxOlder} minor versions older than`;
      versions.push({
        component: first, version: second, location, supported,
        message: `${first} ${rule} kube-apiserver ${version(target)}.`,
      });
    } else if (!rest.length && first.length <= 253 && apiIdentifier.test(first) &&
        (!second || (second.length <= 253 && kindIdentifier.test(second)))) {
      resources.push({ apiVersion: first, kind: second, location });
    } else {
      warnings.push(`${location}: use “component version” or “apiVersion Kind”.`);
    }
  }
  return { versions, resources, warnings };
}

function upgradePath(current: number | null, target: number) {
  if (current === null) return { status: 'not-provided', steps: [] };
  if (current > target) return { status: 'downgrade', steps: [] };
  if (current === target) return { status: 'same-minor', steps: [version(current)] };
  return { status: 'upgrade', steps: Array.from({ length: target - current + 1 }, (_, i) => version(current + i)) };
}

export function checkCompatibility(input: Record<string, unknown>, today = new Date().toISOString().slice(0, 10)) {
  const target = clusterMinor(input.targetVersion, 'target');
  const current = input.currentVersion === undefined || input.currentVersion === ''
    ? null : clusterMinor(input.currentVersion, 'current', 0);
  const manifest = readManifest(textInput(input.manifest, 'Manifest', maxManifestBytes));
  const inventory = readInventory(textInput(input.inventory, 'Inventory', maxInventoryBytes), target);
  const resources = [...manifest.resources, ...inventory.resources];
  return {
    targetVersion: version(target),
    currentVersion: current === null ? null : version(current),
    release: releaseStatus(target, today),
    upgrade: upgradePath(current, target),
    components: inventory.versions,
    apis: resources.map(resource => checkApi(resource, target)),
    warnings: [...manifest.warnings, ...inventory.warnings],
  };
}
