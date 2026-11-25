import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateManifest, type SchemaSet } from './checker';
import { ValidationBudget } from './limits';
import { fromCrdSchema, Unchecked, Validator } from './validator';

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
  it('shares its work allowance between alternative schemas', () => {
    const validator = new Validator({}, new ValidationBudget(2));
    expect(() => validator.validate('secondary', {
      anyOf: [{ type: 'number' }, { type: 'string' }],
    })).toThrow('Manifest is too complex to validate.');
  });

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
                colour: { type: string, pattern: "^blue$" }
                alternative:
                  type: string
                  oneOf: [{ enum: [primary] }, { enum: [secondary] }]
                shade:
                  type: string
                  not: { pattern: "^black$" }
                extra: { type: object, x-kubernetes-preserve-unknown-fields: true }
              x-kubernetes-validations: [{ rule: "self.size < 10" }]
---
apiVersion: example.com/v1
kind: Widget
metadata: { name: small }
spec: { size: 0, colour: red, alternative: primary, shade: white, unexpected: red, extra: { anything: true } }
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
      ['spec.unexpected', 'unknown field "unexpected"'],
    ]);
    expect(widget.notes[0]).toContain('1 x-kubernetes-validations rule (CEL) were not evaluated');
    expect(widget.notes[1]).toContain('Regular-expression patterns from uploaded CustomResourceDefinitions are not evaluated');
    expect(report.resources[2].notes[0]).toContain('Include the CustomResourceDefinition');
  });

  it('reports definite CRD failures separately from results that depend on skipped patterns', async () => {
    const crd = {
      apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: 'widgets.example.com' },
      spec: {
        group: 'example.com', scope: 'Namespaced', names: { plural: 'widgets', singular: 'widget', kind: 'Widget' },
        versions: [{
          name: 'v1', served: true, storage: true,
          schema: { openAPIV3Schema: { type: 'object', properties: {
            spec: { type: 'object', properties: {
              colour: { type: 'string', oneOf: [{ enum: ['blue'], pattern: '^b' }, { enum: ['green'] }] },
              shade: { type: 'string', not: { anyOf: [{ enum: ['black'] }, { pattern: '^g' }] } },
              endpoint: { type: 'string', oneOf: [{ enum: ['auto'] }, { format: 'ipv4' }, { pattern: '^svc-' }] },
              mode: { type: 'string', pattern: '' },
              ranges: { type: 'array', items: { type: 'string' } },
              config: {
                type: 'object', required: ['mode', 'description'], properties: {
                  mode: { type: 'string', nullable: true, enum: ['safe'] },
                  description: { type: 'string', nullable: true },
                },
              },
              settings: {
                type: 'object',
                properties: { mode: { type: 'string', default: 'safe' } },
                not: { properties: { mode: { pattern: '^unsafe$' } } },
              },
            } },
          } } },
        }],
      },
    };
    const widget = (name: string, spec: object) => ({
      apiVersion: 'example.com/v1', kind: 'Widget', metadata: { name }, spec,
    });
    const report = await validate([
      crd, widget('unlisted-colour', { colour: 'red' }), widget('forbidden-shade', { shade: 'black' }),
      widget('unchecked-colour', { colour: 'blue' }), widget('accepted-colour', { colour: 'green' }),
      widget('unchecked-endpoint', { endpoint: 'auto' }), widget('defaulted-mode', { settings: {} }),
      widget('empty-pattern', { mode: 'safe' }), widget('invalid-null', { config: { mode: null, description: null } }),
      widget('valid-null', { config: { mode: 'safe', description: null } }),
      widget('large-array', { ranges: Array(6500).fill('10.0.0.0/24') }),
    ].map(doc => JSON.stringify(doc)).join('\n---\n'));
    expect(report).toMatchObject({ valid: 5, invalid: 3, skipped: 3 });
    expect(report.resources.slice(1)).toMatchObject([
      { status: 'invalid', errors: [{ path: 'spec.colour', message: expect.stringContaining('must be one of') }] },
      { status: 'invalid', errors: [{ path: 'spec.shade', message: 'matches a schema it must not match (not)' }] },
      { status: 'skipped', errors: [], notes: expect.arrayContaining([expect.stringContaining('depends on an unevaluated pattern')]) },
      { status: 'valid', errors: [] },
      { status: 'skipped', errors: [], notes: expect.arrayContaining([expect.stringContaining('string format this checker does not evaluate')]) },
      { status: 'skipped', errors: [], notes: expect.arrayContaining([expect.stringContaining('depends on an unevaluated pattern')]) },
      { status: 'valid', errors: [] },
      { status: 'invalid', errors: [{ path: 'spec.config.mode', message: 'must be one of "safe"; got null' }] },
      { status: 'valid', errors: [] },
      { status: 'valid', errors: [] },
    ]);
  });

  it('preserves known outcomes around unevaluated patterns in nested CRD rules', () => {
    const evaluate = (schema: object, value: unknown = 'green', targetMinor = 37) => {
      const budget = new ValidationBudget();
      const result = new Validator({}, budget).validate(value,
        fromCrdSchema(schema, budget, { rules: 0, patterns: 0 }, { targetMinor, defaulting: true }));
      return result.issues.length ? 'invalid' : result.unchecked ? 'skipped' : 'valid';
    };
    const pattern = { pattern: '^g' };
    const matching = { enum: ['green'] };
    const failing = { enum: ['red'] };
    expect(evaluate({ anyOf: [pattern, matching] })).toBe('valid');
    expect(evaluate({ anyOf: [pattern, failing] })).toBe('skipped');
    expect(evaluate({ oneOf: [pattern, matching] })).toBe('skipped');
    expect(evaluate({ oneOf: [pattern, matching, matching] })).toBe('invalid');
    expect(evaluate({ not: { allOf: [pattern, failing] } })).toBe('valid');
    expect(evaluate({ not: { allOf: [pattern, matching] } })).toBe('skipped');
    expect(evaluate({ not: { properties: { colours: { items: pattern } } } }, { colours: ['green'] })).toBe('skipped');
    expect(evaluate({ not: { additionalProperties: pattern } }, { colour: 'green' })).toBe('skipped');
    expect(evaluate(pattern, 12)).toBe('valid');
    expect(evaluate({ format: 'app-defined' })).toBe('valid');
    expect(evaluate({ format: 'k8s-short-name' }, 'green', 34)).toBe('valid');
    expect(evaluate({ format: 'k8s-short-name' }, 'green', 35)).toBe('skipped');
  });

  it.each(['datetime', 'date-time'])('matches Kubernetes CRD timestamp validation for %s', format => {
    const budget = new ValidationBudget();
    const schema = fromCrdSchema({ type: 'string', format }, budget, { rules: 0, patterns: 0 }, { targetMinor: 36, defaulting: true });
    const validator = new Validator({}, budget);
    for (const value of ['2025-02-28T12:00:00,5Z', '2024-02-29t23:59:59.123+05:30', '2000-02-29T00:00:00Z']) {
      expect(validator.validate(value, schema)).toEqual({ issues: [], unchecked: Unchecked.None });
    }
    for (const value of ['2025-02-28T24:00:00Z', '2025-02-28T12:60:00Z', '2025-02-28T12:00:60Z',
      '1900-02-29T00:00:00Z', '2024-04-31T12:00:00Z', '2024-02-29 12:00:00Z']) {
      expect(validator.validate(value, schema).issues).toEqual([{ path: [], message: expect.stringContaining('Kubernetes date-time') }]);
    }
    const alternative = fromCrdSchema({ type: 'string', oneOf: [{ format }, { enum: ['manual'] }] },
      budget, { rules: 0, patterns: 0 }, { targetMinor: 36, defaulting: true });
    expect(validator.validate('manual', alternative)).toEqual({ issues: [], unchecked: Unchecked.None });
    expect(validator.validate('2025-02-28T12:00:00,5Z', alternative)).toEqual({ issues: [], unchecked: Unchecked.None });
    expect(validator.validate('2025-02-28T24:00:00Z', alternative).issues).not.toHaveLength(0);
  });

  it('uses structural defaults in alternative checks without mutating the input or sharing copies', () => {
    const budget = new ValidationBudget();
    const defaults = { type: 'string', default: 'safe' };
    const schema = fromCrdSchema({
      type: 'object',
      properties: {
        settings: {
          type: 'object', default: {},
          properties: { mode: defaults, nullableMode: { ...defaults, nullable: true } },
        },
        modes: { type: 'array', items: defaults },
        profiles: { type: 'object', additionalProperties: defaults },
      },
      not: { enum: [{ settings: { mode: 'safe', nullableMode: 'safe' }, modes: ['safe'], profiles: { main: 'safe' } }] },
    }, budget, { rules: 0, patterns: 0 }, { targetMinor: 37, defaulting: true });
    const validator = new Validator({}, budget);
    const resource = { modes: [null], profiles: { main: null } };
    expect(validator.validate(resource, schema).issues.map(issue => issue.message)).toEqual(['matches a schema it must not match (not)']);
    expect(resource).toEqual({ modes: [null], profiles: { main: null } });
    expect(schema.properties?.settings.defaultValue).toEqual({});
    expect(() => new Validator({}, new ValidationBudget(2)).validate(resource, schema)).toThrow('Manifest is too complex to validate.');

    const nullable = fromCrdSchema({ type: 'object', properties: { mode: { ...defaults, nullable: true } },
      not: { properties: { mode: { pattern: '^safe$' } } },
    }, budget, { rules: 0, patterns: 0 }, { targetMinor: 37, defaulting: true });
    expect(validator.validate({ mode: null }, nullable).unchecked).toBe(Unchecked.None);
    expect(validator.validate({}, nullable).unchecked).toBe(Unchecked.Pattern);
  });

  it('prunes non-nullable null fields and map entries without shifting array items', () => {
    const budget = new ValidationBudget();
    const schema = fromCrdSchema({
      type: 'object',
      properties: {
        settings: {
          type: 'object', maxProperties: 2,
          required: ['mode', 'nullableMode'],
          properties: {
            mode: { type: 'string', default: 'safe' },
            nullableMode: { type: 'string', nullable: true },
            description: { type: 'string' },
          },
        },
        labels: { type: 'object', additionalProperties: { type: 'string' }, maxProperties: 0 },
        items: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
    }, budget, { rules: 0, patterns: 0 }, { targetMinor: 37, defaulting: true });
    const value = { settings: { description: null, nullableMode: null }, labels: { extra: null }, items: [null] };
    const result = new Validator({}, budget).validate(value, schema);
    expect(result.issues).toEqual([{ path: ['items', 0], message: expect.stringContaining('expected string, got null') }]);
    expect(value.settings).toEqual({ description: null, nullableMode: null });
    expect(value.labels).toEqual({ extra: null });
  });

  it('checks enums for nullable null CRD values even when the enum lists null', () => {
    const budget = new ValidationBudget();
    const schema = fromCrdSchema({ type: 'string', nullable: true, enum: [null, 'safe'] },
      budget, { rules: 0, patterns: 0 }, { targetMinor: 36, defaulting: true });
    expect(new Validator({}, budget).validate(null, schema).issues).toEqual([
      { path: [], message: 'must be one of null, "safe"; got null' },
    ]);
  });

  it.each([
    { minor: 19, preserveUnknownFields: false, status: 'invalid' },
    { minor: 20, preserveUnknownFields: false, status: 'valid' },
    { minor: 21, preserveUnknownFields: false, status: 'valid' },
    { minor: 21, preserveUnknownFields: true, status: 'invalid' },
    { minor: 21, preserveUnknownFields: undefined, status: 'invalid' },
  ])('handles beta CRD nulls on 1.$minor with preserveUnknownFields=$preserveUnknownFields', async ({
    minor, preserveUnknownFields, status,
  }) => {
    const crd = {
      apiVersion: 'apiextensions.k8s.io/v1beta1', kind: 'CustomResourceDefinition', metadata: { name: 'widgets.example.com' },
      spec: {
        group: 'example.com', scope: 'Namespaced', version: 'v1', preserveUnknownFields,
        names: { plural: 'widgets', singular: 'widget', kind: 'Widget' },
        validation: { openAPIV3Schema: { type: 'object', properties: {
          spec: { type: 'object', required: ['mode'], properties: {
            description: { type: 'string' },
            mode: { type: 'string', nullable: true, enum: ['safe'] },
          } },
        } } },
      },
    };
    const widget = (name: string, mode: string | null) => ({
      apiVersion: 'example.com/v1', kind: 'Widget', metadata: { name }, spec: { description: null, mode },
    });
    const report = await validate([crd, widget('optional-null', 'safe'), widget('nullable-enum', null)]
      .map(doc => JSON.stringify(doc)).join('\n---\n'), minor);
    expect(report.resources.map(resource => resource.status)).toEqual(['valid', status, 'invalid']);
    expect(report.resources[1].errors.map(error => error.path)).toEqual(status === 'valid' ? [] : ['spec.description']);
    expect(report.resources[2].errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'spec.mode', message: 'must be one of "safe"; got null' }),
    ]));
  });

  it('requires embedded resource identity after pruning optional beta CRD fields', async () => {
    const crd = {
      apiVersion: 'apiextensions.k8s.io/v1beta1', kind: 'CustomResourceDefinition', metadata: { name: 'widgets.example.com' },
      spec: {
        group: 'example.com', scope: 'Namespaced', version: 'v1', preserveUnknownFields: false,
        names: { plural: 'widgets', singular: 'widget', kind: 'Widget' },
        validation: { openAPIV3Schema: { type: 'object', properties: { template: {
          type: 'object', 'x-kubernetes-embedded-resource': true, 'x-kubernetes-preserve-unknown-fields': true,
          properties: { apiVersion: { type: 'string' }, kind: { type: 'string' } },
        } } } },
      },
    };
    const widget = (name: string, template: Record<string, unknown>) => ({
      apiVersion: 'example.com/v1', kind: 'Widget', metadata: { name }, template,
    });
    const report = await validate([
      crd,
      widget('valid-template', { apiVersion: 'v1', kind: 'ConfigMap' }),
      widget('null-version', { apiVersion: null, kind: 'ConfigMap' }),
      widget('null-kind', { apiVersion: 'v1', kind: null }),
      widget('missing-identity', {}),
      widget('invalid-identity', { apiVersion: '', kind: 2 }),
    ].map(doc => JSON.stringify(doc)).join('\n---\n'), 21);
    expect(report.resources.map(resource => resource.status)).toEqual(['valid', 'valid', 'invalid', 'invalid', 'invalid', 'invalid']);
    expect(report.resources.slice(2).map(resource => resource.errors.map(error => error.path))).toEqual([
      ['template.apiVersion'], ['template.kind'], ['template.apiVersion', 'template.kind'], ['template.apiVersion', 'template.kind'],
    ]);
  });

  it.each([19, 20])('applies v1 defaults and prunes explicit nulls at the Kubernetes 1.20 boundary on 1.%i', async minor => {
    const settings = {
      type: 'object', required: ['mode'], properties: {
        mode: { type: 'string', default: 'safe' },
        description: { type: 'string' },
      },
    };
    const crd = {
      apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: 'widgets.example.com' },
      spec: {
        group: 'example.com', scope: 'Namespaced', names: { plural: 'widgets', singular: 'widget', kind: 'Widget' },
        versions: [{ name: 'v1', served: true, storage: true, schema: { openAPIV3Schema: {
          type: 'object', properties: { settings },
        } } }],
      },
    };
    const widget = (name: string, settings: Record<string, unknown>) => ({
      apiVersion: 'example.com/v1', kind: 'Widget', metadata: { name }, settings,
    });
    const report = await validate([crd, widget('omitted', {}), widget('explicit-null', { mode: null, description: null })]
      .map(doc => JSON.stringify(doc)).join('\n---\n'), minor);
    expect(report.resources.map(resource => resource.status)).toEqual(['valid', 'valid', minor === 19 ? 'invalid' : 'valid']);
    expect(report.resources[2].errors.map(error => error.path)).toEqual(minor === 19 ? ['settings.mode', 'settings.description'] : []);
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
