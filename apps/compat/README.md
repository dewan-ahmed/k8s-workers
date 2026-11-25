# Kubernetes cluster compatibility

Run `npm run dev --workspace @k8s-workers/compat` from the repository root. Deploy to Workers with `npm run deploy --workspace @k8s-workers/compat`.

The checker accepts manifests (including rendered Helm output) and a line-based inventory. It compares components against the selected target API server minor, shows an upstream minor-by-minor upgrade path, and reports target release support using the [Kubernetes release schedule](https://kubernetes.io/releases/). It uses the shared API lifecycle table and selected stable API introduction dates; unrecognized and custom APIs are not verified. It does not connect to any cluster or validate manifest schemas.

Refresh `releases.ts` from the Kubernetes website's release schedule and EOL data when updating the repository's shared Kubernetes version range.
