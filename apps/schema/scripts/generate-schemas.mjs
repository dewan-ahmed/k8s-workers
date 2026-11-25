// Downloads the Kubernetes OpenAPI spec for each supported release and writes compact
// per-release schema files (descriptions and non-validation extensions removed).
// Releases from 1.27 use the OpenAPI v3 spec that kubectl validates against; older ones use v2.
// Usage: npm run generate --workspace @k8s-workers/schema
import { mkdir, writeFile } from 'node:fs/promises';

const releases = {
  16: 'v1.16.15', 17: 'v1.17.17', 18: 'v1.18.20', 19: 'v1.19.16', 20: 'v1.20.15', 21: 'v1.21.14',
  22: 'v1.22.17', 23: 'v1.23.17', 24: 'v1.24.17', 25: 'v1.25.16', 26: 'v1.26.15', 27: 'v1.27.16',
  28: 'v1.28.15', 29: 'v1.29.15', 30: 'v1.30.14', 31: 'v1.31.14', 32: 'v1.32.13', 33: 'v1.33.13',
  34: 'v1.34.13', 35: 'v1.35.10', 36: 'v1.36.6', 37: 'v1.37.2',
};
const keep = ['type', 'format', 'required', 'enum', 'nullable'];
const firstV3Minor = 27;
const outDir = new URL('../public/schemas/', import.meta.url);

function compact(schema) {
  const out = {};
  const [only, ...rest] = schema.allOf ?? [];
  if (only?.$ref && !rest.length) return compact({ ...schema, allOf: undefined, $ref: only.$ref });
  if (schema.$ref) out.$ref = schema.$ref.slice(schema.$ref.lastIndexOf('/') + 1);
  if (schema.allOf) out.allOf = schema.allOf.map(compact);
  for (const key of keep) if (schema[key] !== undefined) out[key] = schema[key];
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, value]) => [name, compact(value)]));
  }
  if (schema.items) out.items = compact(schema.items);
  if (typeof schema.additionalProperties === 'object') out.additionalProperties = compact(schema.additionalProperties);
  return out;
}

async function getJson(url) {
  const response = await fetch(url, { headers: process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {} });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

async function definitionsFor(minor, tag) {
  if (minor < firstV3Minor) {
    return (await getJson(`https://raw.githubusercontent.com/kubernetes/kubernetes/${tag}/api/openapi-spec/swagger.json`)).definitions;
  }
  const files = await getJson(`https://api.github.com/repos/kubernetes/kubernetes/contents/api/openapi-spec/v3?ref=${tag}`);
  const definitions = {};
  for (const file of files.filter(file => file.name.endsWith('_openapi.json'))) {
    Object.assign(definitions, (await getJson(file.download_url)).components.schemas);
  }
  return definitions;
}

const index = { releases: {}, groups: new Set(), served: {} };
await mkdir(outDir, { recursive: true });
for (const [minor, tag] of Object.entries(releases)) {
  const definitions = await definitionsFor(Number(minor), tag);
  const kinds = {};
  for (const [name, definition] of Object.entries(definitions)) {
    if (name.startsWith('io.k8s.apimachinery.')) continue;
    for (const { group, version, kind } of definition['x-kubernetes-group-version-kind'] ?? []) {
      const apiVersion = group ? `${group}/${version}` : version;
      kinds[`${apiVersion}/${kind}`] = name;
      index.groups.add(group);
      const range = index.served[`${apiVersion}/${kind}`] ??= [Number(minor), Number(minor)];
      range[0] = Math.min(range[0], Number(minor));
      range[1] = Math.max(range[1], Number(minor));
    }
  }
  const compacted = Object.fromEntries(Object.entries(definitions).map(([name, value]) => [name, compact(value)]));
  await writeFile(new URL(`1.${minor}.json`, outDir), JSON.stringify({ release: tag, kinds, definitions: compacted }));
  index.releases[minor] = tag;
  console.log(`1.${minor}: ${Object.keys(kinds).length} kinds from ${tag}`);
}
const sorted = Object.fromEntries(Object.entries(index.served).sort(([a], [b]) => a.localeCompare(b)));
await writeFile(new URL('../api-index.json', import.meta.url), JSON.stringify({
  releases: index.releases, groups: [...index.groups].sort(), served: sorted,
}, null, 1) + '\n');
