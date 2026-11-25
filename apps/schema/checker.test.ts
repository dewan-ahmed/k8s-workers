import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateManifest, type SchemaSet } from './checker';

const schemas = (minor: number): SchemaSet =>
  JSON.parse(readFileSync(new URL(`./public/schemas/1.${minor}.json`, import.meta.url), 'utf8'));
const v130 = schemas(30);
const validate = (manifest: string, minor = 30) => validateManifest(manifest, minor, minor === 30 ? v130 : schemas(minor));

const deployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels: { app: web }
spec:
  replicas: 2
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: web
          image: nginx:1.27
          ports: [{ containerPort: 80 }]
          resources: { limits: { cpu: 500m, memory: 256Mi } }
`;

describe('validateManifest', () => {
  it('accepts a valid deployment', async () => {
    const report = await validate(deployment);
    expect(report).toMatchObject({ targetVersion: '1.30', release: 'v1.30.14', scannedResources: 1, valid: 1, invalid: 0 });
    expect(report.resources[0]).toMatchObject({ apiVersion: 'apps/v1', kind: 'Deployment', name: 'web', status: 'valid', errors: [] });
  });

  it('reports unknown fields, wrong types, enums, quantities, and selector mismatches with lines', async () => {
    const manifest = deployment
      .replace('replicas: 2', 'replicas: "2"')
      .replace('image: nginx:1.27', 'image: nginx:1.27\n          imagePullPolicy: Sometimes\n          imagee: typo')
      .replace('memory: 256Mi', 'memory: 256MB')
      .replace('metadata: { labels: { app: web } }', 'metadata: { labels: { app: api } }');
    const [resource] = (await validate(manifest)).resources;
    expect(resource.status).toBe('invalid');
    expect(resource.errors).toEqual(expect.arrayContaining([
      { path: 'spec.replicas', message: 'expected integer, got string "2"', line: 7 },
      expect.objectContaining({ path: 'spec.template.spec.containers[0].imagee', message: 'unknown field "imagee"', line: 16 }),
      expect.objectContaining({ path: 'spec.template.spec.containers[0].resources.limits.memory', message: expect.stringContaining('invalid quantity "256MB"') }),
      expect.objectContaining({ path: 'spec.selector', message: 'selector does not match spec.template.metadata.labels' }),
    ]));
    expect(resource.errors.find(error => error.path.endsWith('imagePullPolicy'))?.message ?? '').toMatch(/Sometimes/);
  });

  it('reports missing required fields and invalid names', async () => {
    const report = await validate(`apiVersion: v1
kind: Service
metadata: { name: 1-web, labels: { "bad key!": x } }
spec:
  ports: [{ targetPort: 80 }]
`);
    expect(report.resources[0].errors.map(error => error.message)).toEqual(expect.arrayContaining([
      'missing required field "port"',
      expect.stringContaining('DNS-1035 label'),
      expect.stringContaining('invalid key "bad key!"'),
    ]));
  });

  it('flags APIs that the selected release does not serve', async () => {
    const manifest = 'apiVersion: extensions/v1beta1\nkind: Ingress\nmetadata: { name: web }\nspec: {}\n';
    expect((await validate(manifest, 16)).resources[0].status).toBe('valid');
    const [resource] = (await validate(manifest, 22)).resources;
    expect(resource.status).toBe('invalid');
    expect(resource.errors[0].message).toContain('not served by Kubernetes 1.22 (served in 1.16–1.21');
    expect(resource.errors[0].message).toContain('networking.k8s.io/v1 Ingress');
  });

  it('validates custom resources against CustomResourceDefinitions in the input', async () => {
    const report = await validate(`apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata: { name: widgets.example.com }
spec:
  group: example.com
  scope: Namespaced
  names: { plural: widgets, singular: widget, kind: Widget }
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              required: [size]
              properties:
                size: { type: integer, minimum: 1 }
                extra: { type: object, x-kubernetes-preserve-unknown-fields: true }
              x-kubernetes-validations: [{ rule: "self.size < 10" }]
---
apiVersion: example.com/v1
kind: Widget
metadata: { name: small }
spec: { size: 0, colour: red, extra: { anything: true } }
---
apiVersion: other.example.com/v1
kind: Gadget
metadata: { name: unknown }
`);
    expect(report).toMatchObject({ scannedResources: 3, valid: 1, invalid: 1, skipped: 1 });
    const widget = report.resources[1];
    expect(widget.schema).toBe('custom resource definition');
    expect(widget.errors.map(error => [error.path, error.message])).toEqual([
      ['spec.size', 'must be at least 1'],
      ['spec.colour', 'unknown field "colour"'],
    ]);
    expect(widget.notes[0]).toContain('1 x-kubernetes-validations rule (CEL) were not evaluated');
    expect(report.resources[2].notes[0]).toContain('Include the CustomResourceDefinition');
  });

  it('expands List objects, accepts JSON, and keeps going past invalid YAML documents', async () => {
    const list = JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [
      { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'a' }, data: { on: 'yes' } },
      { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'b' }, data: { n: 1 } },
    ] });
    const report = await validate(`${list}\n---\nfoo: [unclosed\n---\napiVersion: v1\nkind: Namespace\nmetadata: { name: Prod }\n`);
    expect(report).toMatchObject({ scannedResources: 3, valid: 1, invalid: 2 });
    expect(report.resources[1].errors).toEqual([expect.objectContaining({ path: 'data.n', message: 'expected string, got integer 1' })]);
    expect(report.resources[2].errors[0].message).toContain('DNS-1123 label');
    expect(report.warnings).toEqual([expect.stringContaining('Document 2: skipped invalid YAML')]);
  });

  it('reads YAML 1.1 values the way Kubernetes does', async () => {
    const report = await validate(`apiVersion: v1
kind: ConfigMap
metadata: { name: flags, annotations: { created: 2024-01-01 } }
data: { enabled: yes }
`);
    expect(report.resources[0].errors).toEqual([expect.objectContaining({ path: 'data.enabled', message: 'expected string, got boolean true' })]);
  });
});
