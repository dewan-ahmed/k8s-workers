import { Buffer } from 'node:buffer';
import { gzipSync } from 'node:zlib';
import { pack } from 'tar-stream';
import { describe, expect, it } from 'vitest';
import { makeReport, scanChart, scanManifest } from './scanner';

async function chart(files: Record<string, string | Buffer>) {
  const archive = pack();
  for (const [name, content] of Object.entries(files)) archive.entry({ name }, content);
  archive.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of archive) chunks.push(Buffer.from(chunk));
  return gzipSync(Buffer.concat(chunks));
}

describe('manifest scans', () => {
  it('checks multi-document YAML and List items without treating nested spec fields as resources', () => {
    const scan = scanManifest(`# a deployment
apiVersion: apps/v1beta1
kind: Deployment
metadata: {name: frontend, namespace: demo}
---
apiVersion: v1
kind: List
items:
  - apiVersion: batch/v1beta1
    kind: CronJob
    metadata:
      name: cleanup
  - apiVersion: v1
    kind: ConfigMap
    data:
      apiVersion: batch/v1beta1
      kind: CronJob
`);
    const report = makeReport(scan, 24, 'manifest');
    expect(report).toMatchObject({ scannedResources: 3, removed: 1, deprecated: 1, warnings: [] });
    expect(report.findings).toMatchObject([
      { document: 1, line: 2, name: 'frontend', namespace: 'demo', status: 'removed' },
      { document: 2, line: 9, name: 'cleanup', status: 'deprecated' },
    ]);
  });

  it('skips malformed documents and still checks valid JSON documents', () => {
    const report = makeReport(scanManifest('broken: [\n---\n{"apiVersion":"v1","kind":"Endpoints"}'), 33, 'manifest');
    expect(report).toMatchObject({ scannedResources: 1, deprecated: 1 });
    expect(report.warnings).toEqual([expect.stringContaining('document 1: skipped invalid YAML')]);
  });

  it('locates rendered Helm findings and reports incomplete List entries with CRLF input', () => {
    const input = `---
# Source: test/charts/dep/templates/jobs.yaml
apiVersion: v1
kind: List
items:
  - apiVersion: &legacy batch/v1beta1
    kind: &cron CronJob
    metadata: &job {name: first, namespace: demo}
  - apiVersion: *legacy
    kind: *cron
    metadata: {name: second, namespace: demo}
  - apiVersion: *legacy
    kind: *cron
    metadata: *job
  - kind: CronJob
---
# Empty document
---
apiVersion: batch/v1beta1
kind: CronJob
`.replace(/\n/g, '\r\n');
    const report = makeReport(scanManifest(input), 25, 'manifest');
    const source = 'test/charts/dep/templates/jobs.yaml';
    expect(report).toMatchObject({ scannedResources: 4, removed: 4, deprecated: 0 });
    expect(report.findings).toMatchObject([
      { source, document: 1, line: 6, name: 'first', namespace: 'demo' },
      { source, document: 1, line: 9, name: 'second', namespace: 'demo' },
      { source, document: 1, line: 12, name: 'first', namespace: 'demo' },
      { source: 'manifest', document: 3, line: 19 },
    ]);
    expect(report.warnings).toEqual([`${source}, document 1, line 15: no apiVersion and kind found.`]);
  });

  it('bounds nested List aliases without expanding the YAML document', () => {
    const input = `apiVersion: v1
kind: List
items: &loop
  - apiVersion: v1
    kind: List
    items: *loop
`;
    expect(() => scanManifest(input)).toThrow('Resource list is nested too deeply.');
  });
});

describe('messy manifest input', () => {
  const deployment = (i: number) => `apiVersion: extensions/v1beta1
kind: Deployment
metadata:
  name: app-${i}
  namespace: team-${i % 7}
  labels: {app: web}  # flow style below the resource fields is fine
spec:
  template:
    spec:
      containers:
        - name: web
          image: "nginx:1.${i}"
          args: |
            --port=80
            ---not-a-separator
`;

  it('scans a large multi-document manifest without the full YAML parser', () => {
    const input = Array.from({ length: 6000 }, (_, i) => deployment(i)).join('---\n');
    expect(input.length).toBeGreaterThan(1.5 * 1024 * 1024);
    const scan = scanManifest(input);
    expect(scan.resources).toHaveLength(6000);
    expect(scan.resources[5999]).toMatchObject({ name: 'app-5999', namespace: 'team-0', document: 6000, line: 16 * 5999 + 1 });
    expect(scan.warnings).toEqual([]);
  });

  it('reads JSON objects, arrays, concatenated objects and NDJSON', () => {
    const job = (name: string) => JSON.stringify({ apiVersion: 'batch/v1beta1', kind: 'CronJob', metadata: { name } });
    expect(scanManifest(job('one')).resources).toMatchObject([{ name: 'one', document: 1, line: 1 }]);
    expect(scanManifest(`[${job('a')},\n${job('b')}]`).resources).toMatchObject([{ name: 'a', line: 1 }, { name: 'b', line: 2 }]);
    expect(scanManifest(`${job('a')}\n${job('b')}`).resources).toMatchObject([{ name: 'a', document: 1 }, { name: 'b', document: 2, line: 2 }]);
    const list = JSON.stringify({ apiVersion: 'v1', kind: 'DeploymentList', items: [JSON.parse(job('x'))] }, null, 2);
    expect(scanManifest(list).resources).toMatchObject([{ name: 'x', line: 5 }]);
  });

  it('follows anchors, aliases and merge keys within a document', () => {
    const scan = scanManifest(`apiVersion: v1
kind: List
x-base: &base
  apiVersion: policy/v1beta1
  kind: PodDisruptionBudget
items:
  - <<: *base
    metadata: {name: merged}
  - apiVersion: &v batch/v1beta1
    kind: CronJob
    metadata: {name: aliased}
`);
    expect(scan.resources).toMatchObject([
      { apiVersion: 'policy/v1beta1', name: 'merged', line: 7 },
      { apiVersion: 'batch/v1beta1', name: 'aliased', line: 9 },
    ]);
    expect(scan.warnings).toEqual([]);
  });

  it('keeps later documents after a broken one and counts invalid documents', () => {
    const scan = scanManifest(`apiVersion: "unterminated\nkind: Job\n---\n${deployment(1)}---\n\tkind: Tabbed\n`);
    expect(scan.resources).toMatchObject([{ name: 'app-1', document: 2 }]);
    expect(scan.invalidDocuments).toBe(2);
  });

  it('caps warnings and the number of documents', () => {
    const report = makeReport(scanManifest('a: 1\n---\n'.repeat(500)), 25, 'manifest');
    expect(report.warnings).toHaveLength(51);
    expect(report.warnings.at(-1)).toBe('450 more warnings not shown.');
    expect(() => scanManifest('---\n'.repeat(20001))).toThrow('more than 20000 YAML documents');
  });

  it('rejects input that needs too much full YAML parsing', () => {
    expect(() => scanManifest('a: [\n---\n'.repeat(1000))).toThrow('Too much of this input needs the full YAML parser');
    const deep = scanManifest('apiVersion: ' + '['.repeat(5000) + ']'.repeat(5000));
    expect(deep.warnings).toEqual(['manifest, document 1: skipped YAML nested more than 64 levels deep (line 1).']);
  });
});

describe('chart scans', () => {
  it('checks literal branch versions, CRDs and packaged dependencies, but not helpers or values', async () => {
    const dependency = await chart({
      'dep/Chart.yaml': 'name: dep',
      'dep/templates/pdb.yaml': 'apiVersion: policy/v1beta1\nkind: PodDisruptionBudget',
    });
    const archive = await chart({
      'root/Chart.yaml': 'name: root',
      'root/values.yaml': 'apiVersion: batch/v1beta1\nkind: CronJob',
      'root/templates/_helpers.yaml': 'apiVersion: batch/v1beta1\nkind: CronJob',
      'root/templates/ingress.yaml': `{{- if .Values.legacy }}
apiVersion: networking.k8s.io/v1beta1
{{- else }}
apiVersion: networking.k8s.io/v1
{{- end }}
kind: Ingress
metadata:
  name: {{ .Release.Name }}
`,
      'root/crds/widget.yaml': 'apiVersion: apiextensions.k8s.io/v1beta1\nkind: CustomResourceDefinition',
      'root/charts/dep.tgz': dependency,
    });
    const report = makeReport(await scanChart(new Blob([Uint8Array.from(archive)])), 25, 'chart');
    expect(report).toMatchObject({ scannedResources: 4, removed: 3, deprecated: 0 });
    expect(report.findings.map(f => [f.kind, f.line, f.source])).toEqual([
      ['Ingress', 2, 'root/templates/ingress.yaml'],
      ['CustomResourceDefinition', 1, 'root/crds/widget.yaml'],
      ['PodDisruptionBudget', 1, 'root/charts/dep.tgz:dep/templates/pdb.yaml'],
    ]);
    expect(report.warnings[0]).toContain('Chart scan is static');
  });

  it('rejects a non-Helm archive and a gzip expansion over the chart limit', async () => {
    const nonChart = await chart({ 'root/templates/pod.yaml': 'kind: Pod' });
    await expect(scanChart(new Blob([Uint8Array.from(nonChart)]))).rejects.toThrow('missing top-level Chart.yaml');
    const oversized = await chart({ 'root/Chart.yaml': '0'.repeat(12 * 1024 * 1024) });
    await expect(scanChart(new Blob([Uint8Array.from(oversized)]))).rejects.toMatchObject({ status: 413 });
  });

  it('preserves line numbers across multiline Helm actions', async () => {
    const archive = await chart({
      'root/Chart.yaml': 'name: root',
      'root/templates/job.yaml': '{{- if\n .Values.legacy }}\napiVersion: batch/v1beta1\nkind: CronJob\n{{- end }}\n',
    });
    const scan = await scanChart(new Blob([Uint8Array.from(archive)]));
    expect(scan.resources).toMatchObject([{ kind: 'CronJob', line: 3 }]);
  });
});
