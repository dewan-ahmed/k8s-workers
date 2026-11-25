const byId = id => document.getElementById(id);
const form = byId('validator');
const version = byId('version');
const manifest = byId('manifest');
const check = byId('check');
const tryExample = byId('example');
const report = byId('report');
let revision = 0;

const example = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: storefront
spec:
  replicas: "3"
  selector:
    matchLabels:
      app: storefront
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx:1.27
          ports:
            - containerPort: 80
          resources:
            limits:
              memory: 512MB
          imagePullPolicy: Sometimes
---
apiVersion: v1
kind: Service
metadata:
  name: storefront
spec:
  selector:
    app: storefront
  ports:
    - port: 80
      targetPort: http
  tpye: ClusterIP
`;

function notice(message, error = false) {
  const el = byId('check-status');
  el.textContent = message;
  el.classList.toggle('error', error);
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

form.addEventListener('input', () => {
  revision++;
  report.hidden = true;
  notice('');
});

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'The request could not be completed.');
  return data;
}

function render(data, isExample) {
  const title = byId('results-title');
  title.textContent = isExample ? 'Example validation report' : 'Validation report';
  byId('report-target').textContent = `Kubernetes ${data.targetVersion} (${data.release})`;
  byId('valid-count').textContent = data.valid;
  byId('invalid-count').textContent = data.invalid;
  byId('skipped-count').textContent = data.skipped;
  byId('next-step').textContent = data.invalid
    ? 'Fix the errors below, then validate again.'
    : data.skipped
      ? 'Some resources were not validated. Include their CustomResourceDefinitions to check them too.'
      : data.scannedResources
        ? 'All resources match the schema. Server-side checks such as admission webhooks can still reject them.'
        : 'Check your input for Kubernetes resources, then validate again.';
  byId('warnings').hidden = !data.warnings.length;
  byId('warning-title').textContent = `YAML warnings (${data.warnings.length})`;
  byId('warning-list').replaceChildren(...data.warnings.map(warning => element('li', warning)));
  const order = { invalid: 0, skipped: 1, valid: 2 };
  const resources = [...data.resources].sort((a, b) => order[a.status] - order[b.status] || a.document - b.document);
  byId('resources').replaceChildren(...resources.map(resource => {
    const card = element('article', '', 'finding');
    const identity = [resource.namespace, resource.name].filter(Boolean).join('/');
    const label = [resource.apiVersion, resource.kind].filter(Boolean).join(' ') || 'Unknown resource';
    const location = `document ${resource.document}${resource.line ? ` · line ${resource.line}` : ''}${resource.schema ? ` · ${resource.schema} schema` : ''}`;
    const status = { valid: 'VALID', invalid: `${resource.errors.length} ERROR${resource.errors.length === 1 ? '' : 'S'}`, skipped: 'NOT VALIDATED' }[resource.status];
    card.append(element('span', status, `badge ${resource.status}`), element('h3', `${label}${identity ? ` · ${identity}` : ''}`), element('small', location));
    if (resource.errors.length) {
      const list = element('ul');
      list.append(...resource.errors.map(error => {
        const item = element('li');
        item.append(element('code', error.path), document.createTextNode(` ${error.message}${error.line ? ` (line ${error.line})` : ''}`));
        return item;
      }));
      card.append(list);
    }
    for (const note of resource.notes) card.append(element('p', note));
    return card;
  }));
  report.hidden = false;
  title.focus({ preventScroll: true });
  report.scrollIntoView({ block: 'start' });
}

async function run(input, isExample = false) {
  const current = revision;
  check.disabled = tryExample.disabled = true;
  report.hidden = true;
  notice('Validating…');
  try {
    const data = await api('/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (current !== revision) return;
    notice('');
    render(data, isExample);
  } catch (error) {
    if (current === revision) notice(error.message, true);
  } finally {
    check.disabled = tryExample.disabled = false;
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  run({ manifest: manifest.value, version: version.value });
});

tryExample.addEventListener('click', () => run({ manifest: example, version: version.value }, true));

try {
  const config = await api('/api/config');
  version.replaceChildren(...Array.from({ length: config.latestMinor - config.minimumMinor + 1 }, (_, i) => {
    const value = `1.${config.latestMinor - i}`;
    return new Option(value, value);
  }));
  check.disabled = tryExample.disabled = version.disabled = false;
} catch (error) {
  notice(`Could not load validator configuration: ${error.message}`, true);
}
