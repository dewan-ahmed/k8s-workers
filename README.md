# k8s-workers

Kubernetes tools hosted on k8s.workers.dev with Cloudflare Workers.

## Deprecations checker

The [checker](https://deprecations.k8s.workers.dev) flags cataloged Kubernetes API deprecations and removals for a target release (1.16–1.37). It reports each finding's API version, kind, location, lifecycle dates, replacement and migration guidance.

- **Paste YAML:** Paste one or more YAML documents, a JSON resource, a Kubernetes `List`, or the output of `helm template my-release ./chart --kube-version 1.37.0 --include-crds -f values.yaml`.
- **Upload Helm archive:** Upload a packaged `.tgz`. The static scan looks for literal `apiVersion` and `kind` in templates, CRDs and packaged dependencies. It does not render Helm: inactive branches can be reported, and values-dependent or generated fields can be missed. Use rendered output to check the exact manifests you deploy.
- **Email a summary:** When configured, the Worker sends grouped findings and migration notes, not your raw YAML, filenames, or resource names. Workers Free can only send to destinations already verified in the Cloudflare account.

Each manifest or compressed chart may be up to 2 MiB (the JSON/multipart envelope has a separate 2 MiB + 64 KiB limit). Expanded charts are limited to 12 MiB, including packaged dependencies. Scans are not persisted by the app, but input is sent to the Worker for processing; do not send secrets. A clean report is not a full cluster compatibility check: the catalog does not cover vendor APIs, custom CRDs, feature gates, or field-level validation.

## Use from CI / terminal

`POST /api/check` returns a JSON report. Send a Kubernetes manifest or rendered Helm output directly from a file:

```sh
curl -fsS 'https://deprecations.k8s.workers.dev/api/check?targetVersion=1.25' \
  -H 'Content-Type: application/yaml' --data-binary @manifest.yaml -o report.json
```

Raw bodies also accept `application/x-yaml`, `text/yaml`, and `text/plain`; `targetVersion` is required in the query. For JSON, put both `targetVersion` and the manifest string in the body:

```sh
curl -fsS https://deprecations.k8s.workers.dev/api/check \
  -H 'Content-Type: application/json' \
  --data-binary '{"targetVersion":"1.25","manifest":"apiVersion: batch/v1beta1\nkind: CronJob"}'
```

For a static Helm archive scan, use multipart form fields:

```sh
curl -fsS https://deprecations.k8s.workers.dev/api/check \
  -F targetVersion=1.37 \
  -F chart=@my-chart.tgz
```

The report includes `targetVersion`, `mode` (`manifest` or `chart`), `scannedResources`, `removed` and `deprecated` counts, `findings` with lifecycle and replacement details, and `warnings` for issues such as skipped YAML documents.

HTTP `200` means the scan returned a report, not that the input passed. Errors return JSON with an `error` message: `400` for invalid input (including a missing or unsupported target), `403` for a cross-origin POST, `405` for a wrong method, `413` for oversized input or too many resources, `415` for an unsupported content type, `429` for rate limiting, and `500` for an unexpected scan failure. `GET /api/config` exposes the supported target range.

In CI, stop if curl fails. After a successful manifest scan saved to `report.json`, use `jq -e` to fail on removals, skipped input, or zero scanned resources:

```sh
jq -e '.scannedResources > 0 and .removed == 0 and (.warnings | length == 0)' report.json
```

The gate allows deprecations that have not been removed; add `and .deprecated == 0` if you want to reject them too. Chart archives always return a static-scan warning: apply this strict gate to rendered manifests, not archive reports.

## Develop

Requires Node.js 22 or newer; CI uses Node.js 24.

```sh
npm ci
npm run typecheck
npm test
npm run dev
```

Open http://localhost:8787, or replace the public URL in the examples above with that local origin.

`POST /api/email` accepts the same JSON or multipart input with an additional `to` field. The Worker recomputes the report and rate limits requests by IP and recipient per Cloudflare location. For local simulation, run `npm run dev -- --var EMAIL_FROM:reports@example.com`. Wrangler simulates the email binding; no real messages are sent.

## Deploy

1. Use the Cloudflare account whose [Workers subdomain](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) is `k8s.workers.dev`. The Worker is named `deprecations`, so no custom DNS route is needed.
2. Add GitHub Actions secrets `CLOUDFLARE_API_TOKEN` (account-scoped Workers Scripts Edit) and `CLOUDFLARE_ACCOUNT_ID`. Run **Deploy deprecations** from `main`, or deploy locally with `npm run deploy` with Wrangler authenticated to the same account.
3. To enable email, [onboard a sender domain](https://developers.cloudflare.com/email-service/get-started/send-emails/) you control in Cloudflare Email Service. Your `workers.dev` hostname is not a sender domain. Set the GitHub Actions variable `EMAIL_FROM` to a mailbox on the onboarded domain before running the workflow, or pass `npm run deploy -- --var EMAIL_FROM:reports@your-domain.example` locally. On Workers Free, [add and verify](https://developers.cloudflare.com/email-service/configuration/destination-addresses/) each recipient in Cloudflare first. [Sending to unverified addresses requires Workers Paid](https://developers.cloudflare.com/email-service/platform/pricing/).

## Repository

| Workspace | Purpose |
| --- | --- |
| `apps/deprecations` | TypeScript Worker, site assets, parsers and API |
| `packages/k8s-data` | Shared API lifecycle catalog keyed by API version and kind |
| `packages/email` | Shared Cloudflare Email Sending binding adapter |

Catalog entries link to the Kubernetes [Deprecated API Migration Guide](https://kubernetes.io/docs/reference/using-api/deprecation-guide/), [upstream lifecycle annotations](https://github.com/kubernetes/api/tree/v0.37.2), or the official announcement where appropriate.
