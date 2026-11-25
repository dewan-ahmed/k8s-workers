import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extract } from 'tar-stream';
import { isAlias, isMap, isNode, isScalar, isSeq, LineCounter, parseAllDocuments, visit as visitYaml, type Alias, type Node, type YAMLMap } from 'yaml';
import { findDeprecation } from '@k8s-workers/k8s-data';

export const maxInputBytes = 2 * 1024 * 1024;
const maxChartBytes = 12 * 1024 * 1024;
const maxEntries = 1000;
const maxResources = 10000;
const maxWarnings = 50;
const maxListDepth = 32;
// The yaml library costs about 0.5 ms of CPU per KiB plus a fixed cost per call, so only documents
// the line scanner cannot read go through it, within a budget that fits the Workers Free CPU limit.
const maxParsedBytes = 64 * 1024;
const parseOverheadBytes = 1024;
const maxFlowDepth = 64;
const maxDocuments = 20000;
const maxAliasReads = 10000;

export interface Resource {
  apiVersion: string;
  kind: string;
  name?: string;
  namespace?: string;
  source: string;
  document: number;
  line?: number;
}

export interface Scan {
  resources: Resource[];
  warnings: string[];
  omittedWarnings: number;
  invalidDocuments: number;
}

export class InputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const emptyScan = (): Scan => ({ resources: [], warnings: [], omittedWarnings: 0, invalidDocuments: 0 });
const identifier = (value: string | undefined) => value?.trim().slice(0, 253);
const isList = (kind: string | undefined, hasItems: boolean) => kind === 'List' || (!!kind?.endsWith('List') && hasItems);

function addResource(resources: Resource[], resource: Resource) {
  if (resources.length >= maxResources) throw new InputError(`Too many resources in one scan (limit ${maxResources}).`, 413);
  resources.push(resource);
}

function warn(scan: Scan, message: string) {
  if (scan.warnings.length < maxWarnings) scan.warnings.push(message);
  else scan.omittedWarnings++;
}

export function mergeScan(scan: Scan, part: Scan) {
  for (const resource of part.resources) addResource(scan.resources, resource);
  for (const warning of part.warnings) warn(scan, warning);
  scan.omittedWarnings += part.omittedWarnings;
  scan.invalidDocuments += part.invalidDocuments;
}

type Found = Omit<Resource, 'source' | 'document'>;
interface Note { warning: string; line?: number }
type Entry = Found | Note;
interface Budget { parsedBytes: number; aliasReads: number }
const noResource = 'no apiVersion and kind found.';

// Line scanner for block-style YAML, which is what kubectl, Helm and kustomize emit.
// It returns null whenever a document needs real YAML semantics, and the caller falls back to the yaml library.

const blank = -1;
const keyLine = /^([A-Za-z0-9_][\w./-]*)[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/;
const nonString = /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|[-+]?(?:\.\d+|\d+(?:\.\d*)?)(?:[eE][-+]?\d+)?|0o[0-7]+|0x[0-9a-fA-F]+|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;

function indentOf(line: string) {
  let i = 0;
  while (line.charCodeAt(i) === 32) i++;
  const next = line.charCodeAt(i);
  if (Number.isNaN(next) || next === 35 || (next === 13 && i === line.length - 1)) return blank; // '#' or '\r'
  if (next === 9) return null; // tab in indentation
  return i;
}

interface Field { raw: string; line: number; end: number }

function readMap(lines: string[], start: number, end: number, indent: number, first?: string) {
  const fields = new Map<string, Field>();
  let current: Field | undefined;
  let firstLine: number | undefined;
  for (let i = start; i < end; i++) {
    const text = i === start && first !== undefined ? first : lines[i];
    const level = indentOf(text);
    if (level === blank || (level !== null && level > indent)) continue;
    if (level === null || level < indent) return null;
    firstLine ??= i;
    const rest = text.slice(indent).replace(/\r$/, '');
    if (current && !current.raw && (rest === '-' || rest.startsWith('- '))) continue;
    const match = keyLine.exec(rest);
    if (!match) return null;
    const [, key, raw = ''] = match;
    if (fields.has(key) || !closed(raw)) return null;
    if (current) current.end = i;
    current = { raw: raw.startsWith('#') ? '' : raw, line: i, end };
    fields.set(key, current);
  }
  return { fields, firstLine };
}

function closed(raw: string) {
  const c = raw[0];
  if (c === '"') return /^"(?:[^"\\]|\\.)*"[ \t]*(?:#.*)?$/.test(raw);
  if (c === "'") return /^'(?:[^']|'')*'[ \t]*(?:#.*)?$/.test(raw);
  if (c === '[' || c === '{') return /[\]}][ \t]*(?:#.*)?$/.test(raw);
  return !/^(?:[|>]|\? |:)/.test(raw) || /^[|>][-+0-9]*[ \t]*(?:#.*)?$/.test(raw);
}

function hasChildren(lines: string[], field: Field) {
  for (let i = field.line + 1; i < field.end; i++) if (indentOf(lines[i]) !== blank) return true;
  return false;
}

// A literal string scalar, undefined for a missing field, or null when only the yaml library can decide.
function scalar(lines: string[], field: Field | undefined): string | undefined | null {
  if (!field) return undefined;
  const { raw } = field;
  if (!raw || hasChildren(lines, field)) return null;
  let match = /^"([^"\\]*)"[ \t]*(?:#.*)?$/.exec(raw);
  if (match) return match[1];
  match = /^'((?:[^']|'')*)'[ \t]*(?:#.*)?$/.exec(raw);
  if (match) return match[1].replaceAll("''", "'");
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(raw)) return null;
  const comment = raw.search(/[ \t]#/);
  const value = (comment === -1 ? raw : raw.slice(0, comment)).trimEnd();
  return nonString.test(value) || /: |:$/.test(value) ? null : value;
}

function blockResources(lines: string[], start: number, end: number, indent: number, depth: number, first?: string): Entry[] | null {
  if (depth > maxListDepth) throw new InputError('Resource list is nested too deeply.');
  const map = readMap(lines, start, end, indent, first);
  if (!map || map.firstLine === undefined) return null;
  const { fields } = map;
  const line = map.firstLine + 1;
  const rawVersion = scalar(lines, fields.get('apiVersion'));
  const rawKind = scalar(lines, fields.get('kind'));
  if (rawVersion === null || rawKind === null) return null;
  const apiVersion = identifier(rawVersion);
  const kind = identifier(rawKind);
  const items = fields.get('items');
  if (kind?.endsWith('List') && items) {
    if (items.raw === '[]') return [{ warning: 'resource list is empty.', line }];
    if (items.raw) return null;
    const entries = sequence(lines, items);
    if (entries === null) return null;
    if (entries) {
      const found: Entry[] = [];
      for (const [entryStart, entryEnd, itemIndent] of entries) {
        const rest = lines[entryStart].slice(itemIndent);
        if (!rest.trim() || /^[ \t#]/.test(rest)) return null;
        const item = blockResources(lines, entryStart, entryEnd, itemIndent, depth + 1, ' '.repeat(itemIndent) + rest);
        if (!item) return null;
        found.push(...item);
      }
      return found;
    }
  }
  if (kind === 'List') return [{ warning: 'expected a resource list in items.', line }];
  if (!apiVersion || !kind) return [{ warning: noResource, line }];
  const metadata = fields.get('metadata');
  let name, namespace;
  if (metadata) {
    if (metadata.raw) return null;
    let childIndent: number | null = blank;
    for (let i = metadata.line + 1; i < metadata.end && childIndent === blank; i++) childIndent = indentOf(lines[i]);
    if (childIndent === null) return null;
    if (childIndent !== blank) {
      const meta = readMap(lines, metadata.line + 1, metadata.end, childIndent);
      if (!meta) return null;
      name = scalar(lines, meta.fields.get('name'));
      namespace = scalar(lines, meta.fields.get('namespace'));
      if (name === null || namespace === null) return null;
    }
  }
  return [{ apiVersion, kind, name: identifier(name), namespace: identifier(namespace), line }];
}

function sequence(lines: string[], field: Field): [start: number, end: number, indent: number][] | undefined | null {
  const entries: [number, number, number][] = [];
  let seqIndent: number | undefined;
  for (let i = field.line + 1; i < field.end; i++) {
    const level = indentOf(lines[i]);
    if (level === blank) continue;
    if (level === null) return null;
    seqIndent ??= level;
    if (level < seqIndent) return null;
    if (level > seqIndent) continue;
    if (lines[i][level] !== '-' || !/^-(?:[ \t]|\r?$)/.test(lines[i].slice(level))) return entries.length ? null : undefined;
    if (entries.length) entries.at(-1)![1] = i;
    entries.push([i, field.end, level + 2]);
  }
  return seqIndent === undefined ? undefined : entries;
}

// JSON documents and streams (concatenated objects, NDJSON) go through JSON.parse, which is native and fast.

function jsonValues(text: string, firstLine: number) {
  const values: { value: unknown; line: number; objectLines: number[] | null }[] = [];
  const stack: number[] = [];
  let line = firstLine, start = -1, startLine = 0, inString = false, objectLines: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) line++;
    if (inString) {
      if (c === 92) i++;
      else if (c === 34) inString = false;
      continue;
    }
    if (c === 123 || c === 91) { // '{' '['
      if (!stack.length) { start = i; startLine = line; objectLines = []; }
      if (c === 123 && (!stack.length || stack.at(-1) === 91)) objectLines.push(line);
      if (stack.push(c) > 1000) return null;
    } else if (c === 125 || c === 93) { // '}' ']'
      if (stack.pop() !== c - 2) return null;
      if (!stack.length) {
        const slice = text.slice(start, i + 1);
        try {
          values.push({ value: JSON.parse(slice), line: startLine, objectLines: /"(?:0|[1-9]\d*)"\s*:/.test(slice) ? null : objectLines });
        } catch {
          return null;
        }
      }
    } else if (c === 34) {
      if (!stack.length) return null;
      inString = true;
    } else if (!stack.length && c !== 32 && c !== 9 && c !== 10 && c !== 13) {
      return null;
    }
  }
  return stack.length || !values.length ? null : values;
}

function jsonResources(value: unknown, line: number, objectLines: number[] | null): Entry[] {
  const found: Entry[] = [];
  let next = 0;
  const text = (v: unknown) => typeof v === 'string' ? identifier(v) : undefined;
  const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  function walk(node: unknown, recorded: boolean, candidate: boolean, depth: number) {
    const at = (recorded && objectLines ? objectLines[next++] : undefined) ?? (depth === 0 ? line : undefined);
    if (candidate && depth > maxListDepth) throw new InputError('Resource list is nested too deeply.');
    if (Array.isArray(node)) {
      if (candidate && !node.length) found.push({ warning: noResource, line: at });
      for (const item of node) walk(item, isObject(item), candidate, depth + 1);
      return;
    }
    if (!isObject(node)) {
      if (candidate) found.push({ warning: noResource, line: at });
      return;
    }
    const apiVersion = text(node.apiVersion), kind = text(node.kind);
    const list = candidate && !!kind?.endsWith('List') && Array.isArray(node.items);
    if (list) {
      if (!(node.items as unknown[]).length) found.push({ warning: 'resource list is empty.', line: at });
    } else if (candidate && kind === 'List') {
      found.push({ warning: 'expected a resource list in items.', line: at });
    } else if (candidate && apiVersion && kind) {
      const metadata = isObject(node.metadata) ? node.metadata : {};
      found.push({ apiVersion, kind, name: text(metadata.name), namespace: text(metadata.namespace), line: at });
    } else if (candidate) {
      found.push({ warning: noResource, line: at });
    }
    for (const [key, child] of Object.entries(node)) walk(child, false, list && key === 'items', depth + 1);
  }
  walk(value, !Array.isArray(value), true, 0);
  if (objectLines && next !== objectLines.length) for (const entry of found) entry.line = undefined;
  return found;
}

// Everything else: anchors, merge keys, flow style, tags, invalid YAML.

function flowDepth(text: string) {
  let depth = 0;
  let max = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote || c === '\n') quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') max = Math.max(max, ++depth);
    else if ((c === ']' || c === '}') && depth) depth--;
    else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) while (i < text.length && text[i] !== '\n') i++;
  }
  return max;
}

const yamlString = (node: unknown) => isScalar(node) && typeof node.value === 'string' ? identifier(node.value) : undefined;

function yamlDocuments(text: string, firstLine: number, document: number, location: string, scan: Scan, budget: Budget) {
  if (flowDepth(text) > maxFlowDepth) {
    scan.invalidDocuments++;
    warn(scan, `${location}, document ${document}: skipped YAML nested more than ${maxFlowDepth} levels deep (line ${firstLine}).`);
    return;
  }
  budget.parsedBytes += text.length + parseOverheadBytes;
  if (budget.parsedBytes > maxParsedBytes) {
    throw new InputError('Too much of this input needs the full YAML parser (anchors, flow style, tags, or invalid YAML) to scan within the CPU limit. Split it into smaller scans, or send plain block YAML or JSON.', 413);
  }
  const lineCounter = new LineCounter();
  const lineOf = (offset: number) => firstLine + lineCounter.linePos(offset).line - 1;
  for (const doc of parseAllDocuments(text, { lineCounter, logLevel: 'silent' })) {
    if (doc.errors.length) {
      const error = doc.errors[0];
      scan.invalidDocuments++;
      warn(scan, `${location}, document ${document}: skipped invalid YAML (${error.code}, line ${lineOf(error.pos[0])}).`);
      continue;
    }

    let aliases: WeakMap<Alias, Node> | undefined;
    const resolve = (node: unknown) => {
      if (!isAlias(node)) return node;
      if (++budget.aliasReads > maxAliasReads) throw new InputError('Too many YAML alias references in one scan.', 413);
      if (!aliases) {
        const anchors = new Map<string, Node>();
        const index = new WeakMap<Alias, Node>();
        visitYaml(doc, { Node(_key, item) {
          if (isAlias(item)) {
            const anchored = anchors.get(item.source);
            if (anchored) index.set(item, anchored);
          } else if (item.anchor) {
            anchors.set(item.anchor, item);
          }
        } });
        aliases = index;
      }
      return aliases.get(node);
    };
    // Reads a key, following YAML merge keys (<<: *base) the way Kubernetes tooling applies them.
    const field = (map: YAMLMap, key: string, depth = 0): unknown => {
      const direct = resolve(map.get(key, true));
      if (direct !== undefined || depth > 8) return direct;
      for (const pair of map.items) {
        if (!isScalar(pair.key) || pair.key.value !== '<<') continue;
        const sources = resolve(pair.value);
        for (const base of isSeq(sources) ? sources.items.map(resolve) : [sources]) {
          const value = isMap(base) ? field(base, key, depth + 1) : undefined;
          if (value !== undefined) return value;
        }
      }
      return undefined;
    };

    const visit = (inputNode: unknown, depth: number) => {
      if (depth > maxListDepth) throw new InputError('Resource list is nested too deeply.');
      const node = resolve(inputNode);
      const line = isNode(inputNode) && inputNode.range ? lineOf(inputNode.range[0]) : undefined;
      const position = `${location}, document ${document}${line ? `, line ${line}` : ''}`;
      if (isSeq(node) && node.items.length) {
        node.items.forEach(item => visit(item, depth + 1));
        return;
      }
      if (isMap(node)) {
        const apiVersion = yamlString(field(node, 'apiVersion'));
        const kind = yamlString(field(node, 'kind'));
        const itemsNode = kind?.endsWith('List') ? node.get('items', true) : undefined;
        const items = resolve(itemsNode);
        if (isSeq(items)) {
          if (items.items.length) visit(itemsNode, depth + 1);
          else warn(scan, `${position}: resource list is empty.`);
          return;
        }
        if (kind === 'List') {
          warn(scan, `${position}: expected a resource list in items.`);
          return;
        }
        if (apiVersion && kind) {
          const metadata = field(node, 'metadata');
          addResource(scan.resources, {
            apiVersion, kind, source: location, document, line,
            name: isMap(metadata) ? yamlString(field(metadata, 'name')) : undefined,
            namespace: isMap(metadata) ? yamlString(field(metadata, 'namespace')) : undefined,
          });
          return;
        }
      }
      warn(scan, `${position}: ${noResource}`);
    };

    if (doc.contents && !(isScalar(doc.contents) && (doc.contents.value == null || doc.contents.value === ''))) {
      visit(doc.contents, 0);
    }
  }
}

const marker = /^(?:---|\.\.\.)(?=[ \t\r]|$)/;

export function scanManifest(input: string, source = 'manifest', budget: Budget = { parsedBytes: 0, aliasReads: 0 }): Scan {
  const scan = emptyScan();
  const lines = input.replace(/^\ufeff/, '').split('\n');
  let document = 0;
  let start = 0;
  for (let i = 1; i <= lines.length; i++) {
    if (i < lines.length && !marker.test(lines[i])) continue;
    scanChunk(start, i);
    start = i;
  }
  return scan;

  function record(entries: Entry[], location: string, number: number) {
    for (const entry of entries) {
      if ('warning' in entry) warn(scan, `${location}, document ${number}${entry.line ? `, line ${entry.line}` : ''}: ${entry.warning}`);
      else addResource(scan.resources, { ...entry, source: location, document: number });
    }
  }

  function scanChunk(from: number, to: number) {
    const hasMarker = marker.test(lines[from]);
    const explicit = hasMarker && lines[from].startsWith('---');
    const inline = hasMarker && lines[from].slice(3).replace(/(?:^|[ \t])#.*$/, '').trim() !== '';
    let content = hasMarker ? from + 1 : from;
    while (content < to && (indentOf(lines[content]) === blank || lines[content].startsWith('%'))) content++;
    if (explicit || content < to || inline) document++;
    if (document > maxDocuments) throw new InputError(`Input has more than ${maxDocuments} YAML documents.`, 413);
    if (content >= to && !inline) return;
    // helm template marks each rendered file with a "# Source:" comment right after the separator.
    const location = (source === 'manifest' && explicit && /^---[ \t]*(?:#.*)?\r?$/.test(lines[from])
      ? identifier(/^# Source:[ \t]+([^\r\n]+)/.exec(lines[from + 1] ?? '')?.[1])
      : undefined) || source;
    const firstChar = lines[content]?.trimStart()[0];
    if (!inline && (firstChar === '{' || firstChar === '[')) {
      const values = jsonValues(lines.slice(content, to).join('\n'), content + 1);
      if (values) {
        values.forEach(({ value, line, objectLines }, i) => record(jsonResources(value, line, objectLines), location, document + i));
        document += values.length - 1;
        return;
      }
    }
    const found = inline ? null : blockResources(lines, content, to, 0, 0);
    if (found) record(found, location, document);
    else yamlDocuments(lines.slice(from, to).join('\n'), from + 1, document, location, scan, budget);
  }
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

function scanTemplate(input: string, source: string, budget: Budget): Scan {
  if (!input.includes('{{')) return scanManifest(input, source, budget);
  // Keep line numbers while discarding Go actions, without executing template code.
  const text = input.replace(/\{\{[\s\S]*?\}\}/g, (action, index: number) => {
    const before = input.slice(input.lastIndexOf('\n', index - 1) + 1, index);
    const end = input.indexOf('\n', index + action.length);
    const after = input.slice(index + action.length, end === -1 ? input.length : end);
    return (!before.trim() && !after.trim() ? '' : '?') + action.replace(/[^\r\n]/g, '');
  });
  let offset = 1;
  const scan = emptyScan();
  const docs = text.split(/^---[ \t]*(?:#.*)?$/m);
  for (const [i, doc] of docs.entries()) {
    const lines = doc.split(/\r?\n/);
    const { versions, kinds } = literalFields(lines, offset);
    if (kinds.size === 1 && versions.length) {
      const [kind] = kinds;
      for (const { value, line } of versions) {
        addResource(scan.resources, { apiVersion: value, kind, source, document: i + 1, line });
      }
    } else if (doc.trim()) {
      warn(scan, `${source}, document ${i + 1}: template does not have a single literal kind and literal apiVersion; check rendered output.`);
    }
    offset += lines.length - 1;
  }
  return scan;
}

interface ChartBudget extends Budget {
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
        mergeScan(scan, scanTemplate(file.toString('utf8'), source, budget));
      }
    }
  })()]);
  if (!chartMetadata) throw new InputError('Archive is not a packaged Helm chart: missing top-level Chart.yaml.');
}

export async function scanChart(file: Blob): Promise<Scan> {
  if (!file.size || file.size > maxInputBytes) throw new InputError('Chart must be between 1 byte and 2 MiB.', 413);
  const scan = emptyScan();
  scan.warnings.push('Chart scan is static: literal declarations in inactive branches may be reported, and generated resources or dynamic fields may be missed. Check helm template output for your values.');
  try {
    await visitChart(file.stream(), { bytes: 0, entries: 0, parsedBytes: 0, aliasReads: 0 }, scan);
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
    findings,
    warnings: scan.omittedWarnings ? [...scan.warnings, `${scan.omittedWarnings} more warnings not shown.`] : scan.warnings,
  };
}

export type Report = ReturnType<typeof makeReport>;
