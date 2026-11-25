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
});
