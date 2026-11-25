const byId = id => document.getElementById(id);
const form = byId('checker');
const target = byId('target');
const current = byId('current');
const manifest = byId('manifest');
const inventory = byId('inventory');
const example = byId('example');
const check = byId('check');
const report = byId('report');
const status = byId('check-status');

const apiLabels = {
  available: 'Available', unknown: 'Not verified', removed: 'Removed',
  deprecated: 'Deprecated', unavailable: 'Unavailable',
};
const releaseLabels = {
  supported: 'Supported', maintenance: 'Maintenance mode', eol: 'End of life', unknown: 'Not recorded',
};

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function setStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}

function replaceFindings(id, items, empty) {
  byId(id).replaceChildren(...(items.length ? items : [element('li', empty, 'hint')]));
}

function finding(title, label, tone, message, location) {
  const item = element('li', '', 'finding');
  const heading = element('div', '', 'finding-heading');
  heading.append(element('strong', title), element('span', label, `badge ${tone}`));
  item.append(heading, element('p', message), element('small', location, 'hint'));
  return item;
}

function upgradeMessage({ status, steps }) {
  switch (status) {
    case 'upgrade': return `${steps.join(' → ')}. Upgrade one minor at a time using the latest patch for each step.`;
    case 'same-minor': return 'Same minor version. No minor upgrade is required; use the latest patch.';
    case 'downgrade': return 'The target is older than the current version. This is not a supported upgrade path.';
    default: return 'Enter a current version to calculate the minor upgrade path.';
  }
}

function showReport(data) {
  byId('report-target').textContent = `Target ${data.targetVersion}`;
  const { status, endOfLife } = data.release;
  byId('release').textContent = `${releaseLabels[status]}${endOfLife ? ` · EOL ${endOfLife}` : ''}`;
  byId('upgrade').textContent = upgradeMessage(data.upgrade);
  byId('warnings').hidden = !data.warnings.length;
  byId('warning-list').replaceChildren(...data.warnings.map(warning => element('li', warning)));

  replaceFindings('components', data.components.map(component => finding(
    `${component.component} ${component.version}`, component.supported ? 'Within skew' : 'Outside skew',
    component.supported ? 'available' : 'removed', component.message, component.location,
  )), 'No component versions checked.');
  replaceFindings('apis', data.apis.map(api => {
    const item = finding([api.apiVersion, api.kind].filter(Boolean).join(' '),
      apiLabels[api.status], api.status, api.message, api.location);
    if (api.replacement) item.append(element('p', `Replacement: ${api.replacement.apiVersion} ${api.replacement.kind}`));
    if (api.sourceUrl) {
      const link = element('a', 'Upstream reference');
      link.href = api.sourceUrl;
      item.append(link);
    }
    return item;
  }), 'No resource APIs checked.');

  report.hidden = false;
  byId('results-title').focus();
}

async function initialize() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error();
    const { minimumMinor, latestMinor } = await response.json();
    target.replaceChildren();
    for (let minor = latestMinor; minor >= minimumMinor; minor--) {
      target.add(new Option(`1.${minor}`, `1.${minor}`));
    }
    target.disabled = check.disabled = example.disabled = false;
  } catch {
    setStatus('Could not load Kubernetes versions. Reload the page to try again.', true);
  }
}

example.addEventListener('click', () => {
  target.value = '1.35';
  current.value = '1.32';
  manifest.value = 'apiVersion: batch/v1beta1\nkind: CronJob\nmetadata:\n  name: nightly-cleanup';
  inventory.value = 'kubectl v1.36.1\nkubelet 1.31.4\nnetworking.k8s.io/v1 Ingress\nexample.com/v1 Widget';
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  report.hidden = true;
  check.disabled = true;
  setStatus('Checking compatibility…');
  try {
    const response = await fetch('/api/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetVersion: target.value, currentVersion: current.value.trim(), manifest: manifest.value, inventory: inventory.value,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      setStatus(data.error ?? 'The compatibility check could not be completed.', true);
      return;
    }
    setStatus('');
    showReport(data);
  } catch {
    setStatus('Could not reach the checker. Try again.', true);
  } finally {
    check.disabled = false;
  }
});

initialize();
