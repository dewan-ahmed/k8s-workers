# Kubernetes schema validator

Validates manifests (including rendered Helm output, multi-document YAML, JSON, and `List` objects) against the OpenAPI schema of a Kubernetes release from 1.16 through 1.37. Live at https://schema.k8s.workers.dev.

It reports unknown fields, wrong types, missing required fields, invalid quantities, a few common enum values that the published specs omit, invalid object names and label keys, workload selectors that do not match their pod template, and API versions the selected release does not serve. Custom resources are checked against CustomResourceDefinitions included in the same input, including structural defaults in v1 CRDs. It applies Kubernetes 1.20+ null pruning for v1 CRDs and for v1beta1 CRDs that set `preserveUnknownFields: false` on a release that serves them. Uploaded regular-expression patterns, some string formats, `x-kubernetes-validations` (CEL) rules, admission webhooks, and cluster state are not checked. If a resource fails a checked constraint, it is reported as invalid; if its result depends on an unchecked pattern or format, it is reported as not validated (`skipped` in the API).

Run `npm run dev --workspace @k8s-workers/schema` from the repository root. Deploy with `npm run deploy --workspace @k8s-workers/schema`.

## API

`POST /api/validate` accepts JSON (`{"version": "1.30", "manifest": "..."}`) or a raw manifest with `?version=1.30` and `Content-Type: application/yaml`, `application/x-yaml`, `text/yaml`, or `text/plain`. Input is limited to 2 MiB, 500 documents, and 500 resources. If validation exceeds the work limit, the API returns HTTP 413 rather than a partial result. Split the manifest into smaller batches or simplify deeply nested values and schemas. `GET /api/config` returns the supported version range.

## Schemas

`public/schemas/1.<minor>.json` holds compacted schemas from the latest patch of each release: the OpenAPI v3 spec from 1.27 and the v2 spec before that, with descriptions removed. `api-index.json` records which releases serve each API version and kind. Regenerate both after changing the release list:

```sh
GITHUB_TOKEN=$(gh auth token) npm run generate --workspace @k8s-workers/schema
```

`GITHUB_TOKEN` is optional; it avoids GitHub API rate limits.
