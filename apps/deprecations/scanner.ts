import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extract } from 'tar-stream';
import { isMap, isScalar, isSeq, LineCounter, parseAllDocuments, type Node } from 'yaml';
import { findDeprecation } from '@k8s-workers/k8s-data';

export const maxInputBytes = 2 * 1024 * 1024;
const maxChartBytes = 12 * 1024 * 1024;
const maxEntries = 1000;
const maxResources = 2000;

export interface Resource {
  apiVersion: string;
  kind: string;
  name?: string;
  namespace?: string;
  source: string;
  document: number;
  line?: number;
}

interface Scan {
  resources: Resource[];
  warnings: string[];
}

export class InputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const scalar = (node: unknown) => isScalar(node) && typeof node.value === 'string' ? node.value : undefined;
const identifier = (value: string | undefined) => value?.trim().slice(0, 253);
function addResource(resources: Resource[], resource: Resource) {
  if (resources.length >= maxResources) throw new InputError('Too many resources in one scan.', 413);
  resources.push(resource);
}

export function scanManifest(input: string, source = 'manifest'): Scan {
  const resources: Resource[] = [];
  const warnings: string[] = [];
  const lineCounter = new LineCounter();
  const docs = parseAllDocuments(input, { lineCounter, logLevel: 'silent' });

  function visit(node: Node | null, document: number, depth: number) {
    if (!node) return;
    if (depth > 32) throw new InputError('Resource list is nested too deeply.');
    if (isSeq(node)) {
      node.items.forEach(item => visit(item as Node | null, document, depth + 1));
      return;
    }
    if (!isMap(node)) return;
    const apiVersion = identifier(scalar(node.get('apiVersion', true)));
    const kind = identifier(scalar(node.get('kind', true)));
    const items = node.get('items', true);
    if (kind === 'List' || (kind?.endsWith('List') && isSeq(items))) {
      if (isSeq(items)) visit(items, document, depth + 1);
      return;
    }
    if (!apiVersion || !kind) return;
    const metadata = node.get('metadata', true);
    addResource(resources, {
      apiVersion, kind, source, document,
      name: isMap(metadata) ? identifier(scalar(metadata.get('name', true))) : undefined,
      namespace: isMap(metadata) ? identifier(scalar(metadata.get('namespace', true))) : undefined,
      line: node.range ? lineCounter.linePos(node.range[0]).line : undefined,
    });
  }

  for (const [i, doc] of docs.entries()) {
    if (doc.errors.length) {
      const error = doc.errors[0];
      warnings.push(`${source}, document ${i + 1}: skipped invalid YAML (${error.code}, line ${lineCounter.linePos(error.pos[0]).line}).`);
      continue;
    }
    const before = resources.length;
    visit(doc.contents, i + 1, 0);
    if (before === resources.length && doc.contents && scalar(doc.contents) !== '' &&
        !(isScalar(doc.contents) && doc.contents.value == null)) {
      warnings.push(`${source}, document ${i + 1}: no literal apiVersion and kind found.`);
    }
  }
  return { resources, warnings };
}

function literalFields(lines: string[], offset: number) {
  const versions: { value: string; line: number }[] = [];
  const kinds = new Set<string>();
  for (const [i, line] of lines.entries()) {
    const match = /^(apiVersion|kind):[ \t]+(['"]?)([\w./-]+)\2[ \t]*(?:#.*)?$/.exec(line);
    if (!match) continue;
    if (match[1] === 'apiVersion') versions.push({ value: match[3], line: offset + i });
    else kinds.add(match[3]);
  }
  return { versions, kinds };
}

function scanTemplate(input: string, source: string): Scan {
  if (!input.includes('{{')) return scanManifest(input, source);
  // Keep line numbers while discarding Go actions, without executing template code.
  const text = input.replace(/\{\{[\s\S]*?\}\}/g, (action, index: number) => {
    const before = input.slice(input.lastIndexOf('\n', index - 1) + 1, index);
    const end = input.indexOf('\n', index + action.length);
    const after = input.slice(index + action.length, end === -1 ? input.length : end);
    return (!before.trim() && !after.trim() ? '' : '?') + action.replace(/[^\r\n]/g, '');
  });
  let offset = 1;
  const resources: Resource[] = [];
  const warnings: string[] = [];
  const docs = text.split(/^---[ \t]*(?:#.*)?$/m);
  for (const [i, doc] of docs.entries()) {
    const lines = doc.split(/\r?\n/);
    const { versions, kinds } = literalFields(lines, offset);
    if (kinds.size === 1 && versions.length) {
      const [kind] = kinds;
      for (const { value, line } of versions) {
        addResource(resources, { apiVersion: value, kind, source, document: i + 1, line });
      }
    } else if (doc.trim()) {
      warnings.push(`${source}, document ${i + 1}: template does not have a single literal kind and literal apiVersion; check rendered output.`);
    }
    offset += lines.length - 1;
  }
  return { resources, warnings };
}

interface ChartBudget {
  bytes: number;
  entries: number;
}

async function unpackChart(input: ReadableStream<Uint8Array>, budget: ChartBudget) {
  const reader = input.pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Buffer[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      budget.bytes += value.byteLength;
      if (budget.bytes > maxChartBytes) throw new InputError('Expanded chart is larger than 12 MiB.', 413);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return chunks;
}

async function visitChart(
  input: ReadableStream<Uint8Array>, budget: ChartBudget, scan: Scan, prefix = '', depth = 0,
) {
  if (depth > 5) throw new InputError('Packaged dependencies are nested too deeply.');
  const chunks = await unpackChart(input, budget);
  const archive = extract();
  let chartMetadata = false;

  await Promise.all([pipeline(Readable.from(chunks), archive), (async () => {
    for await (const entry of archive) {
      if (++budget.entries > maxEntries) throw new InputError('Chart contains too many entries.', 413);
      const path = entry.header.name.replace(/^\.\//, '');
      const parts = path.split('/');
      const name = parts.at(-1) ?? '';
      const regular = entry.header.type === 'file' && !parts.some(part => !part || part === '..');
      const inRoot = parts.length === 2;
      if (regular && inRoot && name === 'Chart.yaml') chartMetadata = true;
      const location = /^(?:[^/]+\/charts\/)*[^/]+\/(templates|crds)\/.+$/.exec(path)?.[1];
      const template = location === 'templates'
        ? !name.startsWith('_') && name !== 'NOTES.txt'
        : location === 'crds' && /\.(ya?ml|json)$/i.test(name);
      const dependency = /^(?:[^/]+\/charts\/)+[^/]+\.tgz$/i.test(path);
      if (!regular || (!template && !dependency)) {
        entry.resume();
        continue;
      }
      const data: Buffer[] = [];
      for await (const chunk of entry) data.push(Buffer.from(chunk));
      const file = Buffer.concat(data);
      const source = prefix + path;
      if (dependency) {
        await visitChart(Readable.toWeb(Readable.from([file])) as ReadableStream<Uint8Array>, budget, scan, source + ':', depth + 1);
      } else {
        const result = scanTemplate(file.toString('utf8'), source);
        for (const resource of result.resources) addResource(scan.resources, resource);
        scan.warnings.push(...result.warnings);
      }
    }
  })()]);
  if (!chartMetadata) throw new InputError('Archive is not a packaged Helm chart: missing top-level Chart.yaml.');
}

export async function scanChart(file: Blob): Promise<Scan> {
  if (!file.size || file.size > maxInputBytes) throw new InputError('Chart must be between 1 byte and 2 MiB.', 413);
  const scan: Scan = {
    resources: [],
    warnings: ['Chart scan is static: literal declarations in inactive branches may be reported, and generated resources or dynamic fields may be missed. Check helm template output for your values.'],
  };
  try {
    await visitChart(file.stream(), { bytes: 0, entries: 0 }, scan);
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError('Could not read the chart. Upload a valid Helm .tgz archive.');
  }
  return scan;
}

export function makeReport(scan: Scan, targetMinor: number, mode: 'manifest' | 'chart') {
  const findings = scan.resources.flatMap(resource => {
    const lifecycle = findDeprecation(resource.apiVersion, resource.kind, targetMinor);
    return lifecycle ? [{ ...resource, ...lifecycle }] : [];
  });
  return {
    targetVersion: `1.${targetMinor}`,
    mode, scannedResources: scan.resources.length,
    removed: findings.filter(finding => finding.status === 'removed').length,
    deprecated: findings.filter(finding => finding.status === 'deprecated').length,
    findings, warnings: scan.warnings,
  };
}

export type Report = ReturnType<typeof makeReport>;
