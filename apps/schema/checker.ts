import { findDeprecation } from '@k8s-workers/k8s-data';
import { Composer, isMap, isSeq, LineCounter, Parser, type Node } from 'yaml';
import apiIndex from './api-index.json';
import { InputError, ValidationBudget } from './limits';
import { formatPath, fromCrdSchema, objectMetaRef, Validator, type Issue, type Path, type Schema } from './validator';

export const maxInputBytes = 2 * 1024 * 1024;
const maxResources = 500;

export interface SchemaSet {
  release: string;
  kinds: Record<string, string>;
  definitions: Record<string, Schema>;
}

export interface ResourceResult {
  document: number;
  line?: number;
  apiVersion?: string;
  kind?: string;
  name?: string;
  namespace?: string;
  status: 'valid' | 'invalid' | 'skipped';
  schema: 'built-in' | 'custom resource definition' | null;
  errors: { path: string; message: string; line?: number }[];
  notes: string[];
}

interface Candidate {
  document: number;
  node: Node;
  value: unknown;
  lines: LineCounter;
  parseErrors: string[];
}

interface CrdVersion {
  schema?: Schema;
  served: boolean;
  rules: number;
  patterns: number;
  source: string;
}

const builtinGroups = new Set(apiIndex.groups);
const served: Record<string, number[]> = apiIndex.served;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value : undefined;
const groupOf = (apiVersion: string) => apiVersion.includes('/') ? apiVersion.slice(0, apiVersion.indexOf('/')) : '';

const dns1123Label = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const dns1035Label = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
const dns1123Subdomain = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const qualifiedName = /^([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]$/;
const pathSegmentKinds = new Set(['Role', 'ClusterRole', 'RoleBinding', 'ClusterRoleBinding', 'FlowSchema', 'PriorityLevelConfiguration']);
const workloadKinds = new Set(['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet']);

// The published OpenAPI specs omit enums; the API server enforces these values in every supported release.
const knownEnums: [string, string, string[]][] = [
  ['io.k8s.api.core.v1.Container', 'imagePullPolicy', ['Always', 'Never', 'IfNotPresent']],
  ['io.k8s.api.core.v1.EphemeralContainer', 'imagePullPolicy', ['Always', 'Never', 'IfNotPresent']],
  ['io.k8s.api.core.v1.ContainerPort', 'protocol', ['TCP', 'UDP', 'SCTP']],
  ['io.k8s.api.core.v1.ServicePort', 'protocol', ['TCP', 'UDP', 'SCTP']],
  ['io.k8s.api.core.v1.ServiceSpec', 'type', ['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName']],
  ['io.k8s.api.core.v1.PodSpec', 'restartPolicy', ['Always', 'OnFailure', 'Never']],
  ['io.k8s.api.core.v1.PodSpec', 'dnsPolicy', ['ClusterFirstWithHostNet', 'ClusterFirst', 'Default', 'None']],
];
const withEnums = new WeakSet<SchemaSet>();

function addKnownEnums(schemas: SchemaSet) {
  if (withEnums.has(schemas)) return;
  for (const [definition, field, values] of knownEnums) {
    const property = schemas.definitions[definition]?.properties?.[field];
    if (property && !property.enum) property.enum = values;
  }
  withEnums.add(schemas);
}

function checkValueTree(value: unknown, budget: ValidationBudget, depth = 0) {
  budget.use(depth, typeof value === 'string' ? 1 + Math.floor(value.length / 1024) : 1);
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key.length >= 1024) budget.use(depth, Math.floor(key.length / 1024));
      checkValueTree(child, budget, depth + 1);
    }
  }
}

function parse(input: string, budget: ValidationBudget) {
  const lines = new LineCounter();
  const parser = new Parser(lines.addNewLine);
  const composer = new Composer({
    logLevel: 'silent', version: '1.1',
    // Kubernetes decodes YAML 1.1 booleans and octals, but keeps timestamps as strings.
    customTags: tags => tags.filter(tag => typeof tag === 'object' && tag.tag !== 'tag:yaml.org,2002:timestamp'),
  });
  const candidates: Candidate[] = [];
  const warnings: string[] = [];
  let document = 0;
  for (const doc of composer.compose(parser.parse(input))) {
    if (++document > maxResources) throw new InputError(`Validate at most ${maxResources} documents at a time.`, 413);
    const fatal = doc.errors.filter(error => error.code !== 'DUPLICATE_KEY');
    if (fatal.length) {
      warnings.push(`Document ${document}: skipped invalid YAML (${fatal[0].message.split('\n')[0]})`);
      continue;
    }
    if (!doc.contents) continue;
    const parseErrors = doc.errors.map(error => `${error.message.split('\n')[0]}`);
    let value: unknown;
    try {
      value = doc.toJS({ maxAliasCount: 100 });
    } catch (error) {
      warnings.push(`Document ${document}: skipped (${error instanceof Error ? error.message : 'could not be read'})`);
      continue;
    }
    checkValueTree(value, budget);
    const contents = doc.contents as Node;
    const kind = isObject(value) ? text(value.kind) : undefined;
    if (isObject(value) && kind?.endsWith('List') && Array.isArray(value.items) && isMap(contents)) {
      if (candidates.length + value.items.length > maxResources) throw new InputError(`Validate at most ${maxResources} resources at a time.`, 413);
      const items = contents.get('items', true);
      value.items.forEach((item, index) => {
        const node = isSeq(items) ? items.items[index] as Node : contents;
        candidates.push({ document, node, value: item, lines, parseErrors });
      });
    } else if (value !== null && value !== undefined && value !== '') {
      candidates.push({ document, node: contents, value, lines, parseErrors });
    }
    if (candidates.length > maxResources) throw new InputError(`Validate at most ${maxResources} resources at a time.`, 413);
  }
  return { candidates, warnings };
}

function lineAt(candidate: Candidate, path: Path) {
  let node: unknown = candidate.node;
  for (const part of path) {
    const next = isMap(node) ? node.get(part, true) : isSeq(node) && typeof part === 'number' ? node.items[part] : undefined;
    if (!next) break;
    node = next;
  }
  const range = (node as Node | null)?.range;
  return range ? candidate.lines.linePos(range[0]).line : undefined;
}

function collectCrds(candidates: Candidate[], budget: ValidationBudget) {
  const crds = new Map<string, CrdVersion>();
  for (const { value, document } of candidates) {
    if (!isObject(value) || value.kind !== 'CustomResourceDefinition' || !text(value.apiVersion)?.startsWith('apiextensions.k8s.io/')) continue;
    const spec = isObject(value.spec) ? value.spec : {};
    const group = text(spec.group);
    const kind = isObject(spec.names) ? text(spec.names.kind) : undefined;
    if (!group || !kind) continue;
    const shared = isObject(spec.validation) ? spec.validation.openAPIV3Schema : undefined;
    const versions = Array.isArray(spec.versions) && spec.versions.length
      ? spec.versions.filter(isObject)
      : [{ name: spec.version, served: true }];
    for (const version of versions) {
      const name = text(version.name);
      if (!name) continue;
      const raw = isObject(version.schema) ? version.schema.openAPIV3Schema : shared;
      const counter = { rules: 0, patterns: 0 };
      const schema = raw === undefined ? undefined : fromCrdSchema(raw, budget, counter);
      if (schema) {
        schema.type = 'object';
        schema.properties = { ...schema.properties, apiVersion: { type: 'string' }, kind: { type: 'string' }, metadata: { $ref: objectMetaRef } };
      }
      crds.set(`${group}/${name}/${kind}`, { schema, served: version.served !== false, ...counter, source: `document ${document}` });
    }
  }
  return crds;
}

function labelIssues(labels: unknown, path: Path, issues: Issue[], checkValues = true) {
  if (!isObject(labels)) return;
  for (const [key, value] of Object.entries(labels)) {
    const slash = key.lastIndexOf('/');
    const prefix = slash >= 0 ? key.slice(0, slash) : undefined;
    const name = key.slice(slash + 1);
    if ((prefix !== undefined && (prefix.length > 253 || !dns1123Subdomain.test(prefix))) || name.length > 63 || !qualifiedName.test(name)) {
      issues.push({ path: [...path, key], message: `invalid key "${key}"; use an optional DNS subdomain prefix and a name of up to 63 alphanumeric characters, "-", "_" or "."` });
    }
    if (checkValues && typeof value === 'string' && value !== '' && (value.length > 63 || !qualifiedName.test(value))) {
      issues.push({ path: [...path, key], message: `invalid label value "${value}"; use up to 63 alphanumeric characters, "-", "_" or ".", starting and ending with an alphanumeric character` });
    }
  }
}

function selectorMatches(selector: Record<string, unknown>, labels: Record<string, unknown>) {
  const matchLabels = isObject(selector.matchLabels) ? selector.matchLabels : {};
  if (!Object.entries(matchLabels).every(([key, value]) => labels[key] === value)) return false;
  const expressions = Array.isArray(selector.matchExpressions) ? selector.matchExpressions.filter(isObject) : [];
  return expressions.every(({ key, operator, values }) => {
    const present = typeof key === 'string' && Object.hasOwn(labels, key);
    const list = Array.isArray(values) ? values : [];
    if (operator === 'In') return present && list.includes(labels[key as string]);
    if (operator === 'NotIn') return !present || !list.includes(labels[key as string]);
    if (operator === 'Exists') return present;
    if (operator === 'DoesNotExist') return !present;
    return true;
  });
}

function apiChecks(resource: Record<string, unknown>, kind: string, builtin: boolean, issues: Issue[]) {
  const metadata = isObject(resource.metadata) ? resource.metadata : {};
  const name = text(metadata.name);
  if (!name && !text(metadata.generateName) && !kind.endsWith('Review')) {
    issues.push({ path: ['metadata'], message: 'metadata.name or metadata.generateName is required' });
  }
  if (name && builtin) {
    if (kind === 'CustomResourceDefinition') {
      const spec = isObject(resource.spec) ? resource.spec : {};
      const plural = isObject(spec.names) ? text(spec.names.plural) : undefined;
      if (plural && text(spec.group) && name !== `${plural}.${spec.group}`) {
        issues.push({ path: ['metadata', 'name'], message: `must be spec.names.plural + "." + spec.group ("${plural}.${spec.group}")` });
      }
    } else if (pathSegmentKinds.has(kind)) {
      if (name === '.' || name === '..' || /[/%]/.test(name)) issues.push({ path: ['metadata', 'name'], message: `"${name}" may not be "." or "..", or contain "/" or "%"` });
    } else if (kind === 'Service' && (name.length > 63 || !dns1035Label.test(name))) {
      issues.push({ path: ['metadata', 'name'], message: `"${name}" must be a DNS-1035 label: up to 63 lowercase letters, digits or "-", starting with a letter` });
    } else if (kind === 'Namespace' && (name.length > 63 || !dns1123Label.test(name))) {
      issues.push({ path: ['metadata', 'name'], message: `"${name}" must be a DNS-1123 label: up to 63 lowercase alphanumeric characters or "-"` });
    } else if (kind !== 'Namespace' && kind !== 'Service' && (name.length > 253 || !dns1123Subdomain.test(name))) {
      issues.push({ path: ['metadata', 'name'], message: `"${name}" must be a DNS-1123 subdomain: lowercase alphanumeric characters, "-" or ".", starting and ending with an alphanumeric character` });
    }
  }
  const namespace = text(metadata.namespace);
  if (namespace && (namespace.length > 63 || !dns1123Label.test(namespace))) {
    issues.push({ path: ['metadata', 'namespace'], message: `"${namespace}" must be a DNS-1123 label: up to 63 lowercase alphanumeric characters or "-"` });
  }
  labelIssues(metadata.labels, ['metadata', 'labels'], issues);
  labelIssues(metadata.annotations, ['metadata', 'annotations'], issues, false);
  const spec = isObject(resource.spec) ? resource.spec : undefined;
  const template = spec && isObject(spec.template) && isObject(spec.template.metadata) ? spec.template.metadata : undefined;
  if (template) labelIssues(template.labels, ['spec', 'template', 'metadata', 'labels'], issues);
  if (builtin && workloadKinds.has(kind) && spec && isObject(spec.selector) && template && isObject(template.labels) &&
      !selectorMatches(spec.selector, template.labels)) {
    issues.push({ path: ['spec', 'selector'], message: 'selector does not match spec.template.metadata.labels' });
  }
}

export async function validateManifest(input: string, targetMinor: number, schemas: SchemaSet) {
  const budget = new ValidationBudget();
  const { candidates, warnings } = parse(input, budget);
  addKnownEnums(schemas);
  const validator = new Validator(schemas.definitions, budget);
  const crds = collectCrds(candidates, budget);
  const resources: ResourceResult[] = candidates.map(candidate => {
    const { value, document } = candidate;
    const result: ResourceResult = { document, line: lineAt(candidate, []), status: 'skipped', schema: null, errors: [], notes: [] };
    const fail = (issues: Issue[]) => {
      result.errors.push(...issues.map(issue => ({ path: formatPath(issue.path), message: issue.message, line: lineAt(candidate, issue.path) })));
    };
    if (!isObject(value)) {
      result.status = 'invalid';
      fail([{ path: [], message: 'expected a Kubernetes object with apiVersion and kind' }]);
      return result;
    }
    result.apiVersion = text(value.apiVersion);
    result.kind = text(value.kind);
    if (isObject(value.metadata)) {
      result.name = text(value.metadata.name);
      result.namespace = text(value.metadata.namespace);
    }
    const { apiVersion, kind } = result;
    if (!apiVersion || !kind) {
      result.status = 'invalid';
      fail([{ path: [], message: !apiVersion ? 'missing required field "apiVersion"' : 'missing required field "kind"' }]);
      return result;
    }
    const gvk = `${apiVersion}/${kind}`;
    const definition = schemas.kinds[gvk];
    const crd = crds.get(gvk);
    const issues: Issue[] = candidate.parseErrors.map(message => ({ path: [], message }));
    let patternOutcomeUnknown = false;
    if (definition) {
      result.schema = 'built-in';
      issues.push(...validator.validate(value, { $ref: definition }).issues);
    } else if (builtinGroups.has(groupOf(apiVersion))) {
      result.schema = 'built-in';
      const range = served[gvk];
      const lifecycle = findDeprecation(apiVersion, kind, targetMinor);
      const replacement = lifecycle?.replacement ? ` Use ${lifecycle.replacement.apiVersion} ${lifecycle.replacement.kind}.` : '';
      issues.push({
        path: ['apiVersion'],
        message: range
          ? `${apiVersion} ${kind} is not served by Kubernetes 1.${targetMinor} (served in 1.${range[0]}${range[1] > range[0] ? `–1.${range[1]}` : ''} of the supported releases).${replacement}`
          : `${kind} is not a resource in ${apiVersion} for Kubernetes 1.${targetMinor}.${replacement}`,
      });
    } else if (crd) {
      result.schema = 'custom resource definition';
      if (!crd.served) issues.push({ path: ['apiVersion'], message: `${apiVersion} is not served by the CustomResourceDefinition in ${crd.source}` });
      else if (crd.schema) {
        const validation = validator.validate(value, crd.schema);
        issues.push(...validation.issues);
        patternOutcomeUnknown = validation.unknown;
      } else result.notes.push(`The CustomResourceDefinition in ${crd.source} has no schema for ${apiVersion}, so fields are not validated.`);
      if (crd.rules) result.notes.push(`${crd.rules} x-kubernetes-validations rule${crd.rules === 1 ? '' : 's'} (CEL) were not evaluated.`);
      if (crd.patterns) result.notes.push('Regular-expression patterns from uploaded CustomResourceDefinitions are not evaluated.');
    } else {
      result.notes.push('No schema available. Include the CustomResourceDefinition in the input to validate this custom resource.');
      return result;
    }
    apiChecks(value, kind, result.schema === 'built-in', issues);
    fail(issues);
    result.status = result.errors.length ? 'invalid' : patternOutcomeUnknown ? 'skipped' : 'valid';
    if (result.status === 'skipped') result.notes.push('Validation is incomplete because the result depends on an unevaluated pattern.');
    return result;
  });
  return {
    targetVersion: `1.${targetMinor}`,
    release: schemas.release,
    scannedResources: resources.length,
    valid: resources.filter(resource => resource.status === 'valid').length,
    invalid: resources.filter(resource => resource.status === 'invalid').length,
    skipped: resources.filter(resource => resource.status === 'skipped').length,
    resources,
    warnings,
  };
}

export type Report = Awaited<ReturnType<typeof validateManifest>>;
