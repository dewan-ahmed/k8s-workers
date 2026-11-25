const byId = id => document.getElementById(id);
const checker = byId('checker');
const target = byId('target');
const manifest = byId('manifest');
const chart = byId('chart');
const check = byId('check');
const tryExample = byId('example');
const report = byId('report');
const emailForm = byId('email-form');
const send = byId('send');
let snapshot;
let revision = 0;
let config;

const example = `apiVersion: extensions/v1beta1
kind: Ingress
metadata:
  name: storefront
---
apiVersion: batch/v1beta1
kind: CronJob
metadata:
  name: nightly-cleanup
---
apiVersion: v1
kind: Endpoints
metadata:
  name: storefront
`;

function notice(id, message, error = false) {
  const el = byId(id);
  el.textContent = message;
  el.classList.toggle('error', error);
}

function syncInputs() {
  revision++;
  const isChart = checker.elements.mode.value === 'chart';
  byId('manifest-pane').hidden = manifest.disabled = isChart;
  byId('chart-pane').hidden = chart.disabled = !isChart;
  snapshot = undefined;
  report.hidden = true;
  notice('check-status', '');
  notice('email-status', '');
}

checker.addEventListener('input', syncInputs);

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({
    error: `The checker could not process this request (HTTP ${response.status}). Try a smaller input.`,
  }));
  if (!response.ok) throw new Error(data.error ?? 'The request could not be completed.');
  return data;
}

function requestPayload(input, to) {
  if ('chart' in input) {
    const body = new FormData();
    body.set('chart', input.chart);
    body.set('targetVersion', input.targetVersion);
    if (to) body.set('to', to);
    return { method: 'POST', body };
  }
  if (!to) {
    // Raw YAML avoids JSON escaping, which can push a manifest under 2 MiB past the request limit.
    return { method: 'POST', headers: { 'Content-Type': 'text/yaml' }, body: input.manifest };
  }
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, to }),
  };
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function render(data, isExample) {
  const title = byId('results-title');
  title.textContent = isExample ? 'Example upgrade report' : 'Upgrade report';
  byId('report-target').textContent = `Kubernetes ${data.targetVersion}`;
  byId('scanned-count').textContent = data.scannedResources;
  byId('removed-count').textContent = data.removed;
  byId('deprecated-count').textContent = data.deprecated;
  byId('next-step').textContent = data.removed
    ? 'Fix removed APIs before upgrading. Use the migration notes below, then scan again.'
    : data.deprecated
      ? 'Plan to migrate deprecated APIs before they are removed. See the migration notes below.'
      : data.scannedResources
        ? 'Review any scan warnings and test your workloads on the target version before upgrading.'
        : 'Check your input for Kubernetes resources, then scan again.';
  byId('warnings').hidden = !data.warnings.length;
  byId('warning-title').textContent = `Scan warnings (${data.warnings.length})`;
  byId('warning-list').replaceChildren(...data.warnings.map(warning => element('li', warning)));
  byId('empty').hidden = !!data.findings.length;
  byId('empty').textContent = data.scannedResources
    ? 'No cataloged removals or deprecations found for this target.'
    : 'No Kubernetes resources were scanned.';
  byId('findings').replaceChildren(...data.findings.map(finding => {
    const card = element('article', '', 'finding');
    const identity = [finding.namespace, finding.name].filter(Boolean).join('/');
    const location = `${finding.source} · document ${finding.document}${finding.line ? ` · line ${finding.line}` : ''}`;
    const lifecycle = finding.removedIn === null ? 'No removal announced' : `Removed in 1.${finding.removedIn}`;
    const replacement = finding.replacement ? `${finding.replacement.apiVersion} ${finding.replacement.kind}` : 'No direct API replacement';
    const link = element('a', 'Upstream reference ↗');
    link.href = finding.sourceUrl;
    card.append(
      element('span', finding.status.toUpperCase(), `badge ${finding.status}`),
      element('h3', `${finding.apiVersion} ${finding.kind}${identity ? ` · ${identity}` : ''}`),
      element('small', location),
      element('p', `Deprecated in 1.${finding.deprecatedIn} · ${lifecycle}`),
      element('p', `Replacement: ${replacement}`),
      element('p', finding.notes),
      link,
    );
    return card;
  }));
  emailForm.hidden = !config.emailEnabled || !data.scannedResources;
  send.disabled = !config.emailEnabled;
  notice('email-status', '');
  report.hidden = false;
  title.focus({ preventScroll: true });
  report.scrollIntoView({ block: 'start' });
}

async function runCheck(input, isExample = false) {
  const current = revision;
  check.disabled = tryExample.disabled = true;
  report.hidden = true;
  snapshot = undefined;
  notice('check-status', 'Scanning…');
  try {
    const path = 'chart' in input ? '/api/check' : `/api/check?targetVersion=${encodeURIComponent(input.targetVersion)}`;
    const data = await api(path, requestPayload(input));
    if (current !== revision) return;
    snapshot = input;
    notice('check-status', '');
    render(data, isExample);
  } catch (error) {
    if (current === revision) notice('check-status', error.message, true);
  } finally {
    check.disabled = tryExample.disabled = false;
  }
}

checker.addEventListener('submit', event => {
  event.preventDefault();
  const input = checker.elements.mode.value === 'chart'
    ? { chart: chart.files[0], targetVersion: target.value }
    : { manifest: manifest.value, targetVersion: target.value };
  runCheck(input);
});

tryExample.addEventListener('click', () => runCheck({ manifest: example, targetVersion: target.value }, true));

emailForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!snapshot || !config.emailEnabled) return;
  const input = snapshot;
  send.disabled = true;
  notice('email-status', 'Sending…');
  try {
    await api('/api/email', requestPayload(input, byId('recipient').value));
    if (snapshot === input) notice('email-status', 'Report accepted for delivery.');
  } catch (error) {
    if (snapshot === input) notice('email-status', error.message, true);
  } finally {
    if (snapshot === input) send.disabled = false;
  }
});

try {
  config = await api('/api/config');
  target.replaceChildren(...Array.from({ length: config.latestMinor - config.minimumMinor + 1 }, (_, i) => {
    const version = `1.${config.latestMinor - i}`;
    return new Option(version, version);
  }));
  check.disabled = tryExample.disabled = target.disabled = false;
} catch (error) {
  notice('check-status', `Could not load checker configuration: ${error.message}`, true);
}
