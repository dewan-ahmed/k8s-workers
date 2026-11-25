import { isMap, isScalar, isSeq, LineCounter, parseAllDocuments, type Node } from 'yaml';

export interface Resource {
  apiVersion: string;
  kind?: string;
  location: string;
}

export class InputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export const apiIdentifier = /^[a-z0-9][a-z0-9.-]*(?:\/[a-z0-9][a-z0-9.-]*)?$/;
export const kindIdentifier = /^[A-Za-z][A-Za-z0-9]*$/;
const literal = (node: unknown) => isScalar(node) && typeof node.value === 'string' ? node.value : '';

export function readManifest(input: string) {
  const resources: Resource[] = [];
  const warnings: string[] = [];
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(input, { lineCounter, logLevel: 'silent' });
  if (documents.length > 1000) throw new InputError('Too many manifest documents.', 413);

  function visit(node: Node | null, document: number, depth: number) {
    if (!node || (isScalar(node) && node.value === null)) return;
    if (depth > 32) throw new InputError('Resource list is nested too deeply.');
    if (isSeq(node)) {
      for (const child of node.items) visit(child as Node | null, document, depth + 1);
      return;
    }
    const line = node.range && lineCounter.linePos(node.range[0]).line;
    const location = `Manifest document ${document}${line ? `, line ${line}` : ''}`;
    const apiVersion = isMap(node) ? literal(node.get('apiVersion', true)) : '';
    const kind = isMap(node) ? literal(node.get('kind', true)) : '';
    const items = isMap(node) ? node.get('items', true) : undefined;
    if ((kind === 'List' || kind.endsWith('List')) && isSeq(items)) {
      visit(items, document, depth + 1);
    } else if (apiIdentifier.test(apiVersion) && apiVersion.length <= 253 &&
        kindIdentifier.test(kind) && kind.length <= 253) {
      if (resources.length >= 1000) throw new InputError('Too many manifest resources.', 413);
      resources.push({ apiVersion, kind, location });
    } else {
      warnings.push(`${location}: skipped entry without a literal apiVersion and kind.`);
    }
  }

  for (const [index, doc] of documents.entries()) {
    if (doc.errors.length) {
      const issue = doc.errors[0];
      warnings.push(`Manifest document ${index + 1}, line ${lineCounter.linePos(issue.pos[0]).line}: skipped invalid YAML (${issue.code}).`);
    } else {
      visit(doc.contents, index + 1, 0);
    }
  }
  return { resources, warnings };
}
