import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Regenerate the checked-in assets with Chrome/Chromium: node packages/ui/generate-link-previews.mjs
const browser = process.env.CHROME_BIN ?? 'google-chrome';
const tools = [
  ['deprecations', 'API Deprecations', 'Find removed APIs in manifests and Helm charts.', '#ffe279'],
  ['compat', 'Cluster Compatibility', 'Check version skew and plan your upgrade.', '#d9eacb'],
  ['schema', 'Schema Validator', 'Catch manifest errors before kubectl apply.', '#dbe7fc'],
];
const ink = '#292d29';
const paper = '#fbf8ef';

const cube = `<g stroke="${ink}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
  <path d="M25 62 126 11 227 62V186l-101 53L25 186Z" fill="#ffdc6b"/>
  <path d="M126 114 227 62V186l-101 53Z" fill="#e7b94f"/>
  <path d="M25 62 126 114 227 62 126 11Z" fill="#fff1ac"/>
  <path d="m70 85 101-51"/>
  <path d="M53 125v5m41 16v5" stroke-width="11"/>
  <path d="M56 153q10 19 25 14" fill="none"/>
  <path d="m163 159 11 9 23-30" fill="none" stroke="#324c38" stroke-width="9"/>
</g>`;

function svg(width, height, markup) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n${markup}\n</svg>\n`;
}

const icon = svg(64, 64, `<rect x="1.5" y="1.5" width="61" height="61" rx="14" fill="${paper}" stroke="${ink}" stroke-width="3"/>
<g transform="translate(4 3) scale(.22)">${cube}</g>`);

function card(index, title, tagline, accent) {
  return svg(1200, 630, `
  <defs><pattern id="dots" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="5" cy="5" r="1.25" fill="#d9d6ca"/></pattern></defs>
  <path fill="${paper}" d="M0 0h1200v630H0z"/>
  <path fill="url(#dots)" d="M0 0h1200v630H0z"/>
  <rect x="38" y="37" width="1132" height="570" rx="30" fill="${ink}"/>
  <rect x="30" y="28" width="1132" height="570" rx="30" fill="#fffef9" stroke="${ink}" stroke-width="3"/>
  <rect x="80" y="84" width="42" height="42" rx="11" fill="#ffe279" stroke="${ink}" stroke-width="3" transform="rotate(-8 101 105)"/>
  <path d="m101 91 4 10 10 4-10 4-4 10-4-10-10-4 10-4Z" fill="${ink}"/>
  <rect x="80" y="460" width="235" height="45" rx="22" fill="${accent}" stroke="${ink}" stroke-width="2"/>
  <g fill="${ink}" font-family="Liberation Sans, Arial, sans-serif">
    <text x="139" y="114" font-size="28" font-weight="700">k8s.workers.dev</text>
    <text x="78" y="242" font-size="76" font-weight="700" letter-spacing="-3">Kubernetes</text>
    <text x="79" y="320" font-size="60" font-weight="700" letter-spacing="-1.5">${title}</text>
    <text x="82" y="382" font-size="29" fill="#4a554b">${tagline}</text>
    <text x="197.5" y="489" text-anchor="middle" font-size="17" letter-spacing="2" font-weight="700">0${index} / UPGRADE TOOLS</text>
  </g>
  <g transform="translate(772 150)">
    <ellipse cx="166" cy="330" rx="127" ry="16" fill="#e6e4d7"/>
    <path d="M43 88c54-64 188-67 245-7 48 51 25 153-32 199-61 48-175 50-215-8-39-55-42-130 2-184Z" fill="${accent}"/>
    <path d="m273 16 6 15 15 6-15 6-6 15-6-15-15-6 15-6Z" fill="#ffe279" stroke="${ink}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M33 60v24m-12-12h24m251 164v22m-11-11h22" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>
    <g fill="none" stroke="${ink}" stroke-width="8" stroke-linecap="round">
      <path d="M75 181q-31 0-37 30m242-34q24-4 28-30M126 267l-8 47h-15m84-47 10 47h15"/>
    </g>
    <g transform="translate(39 49) scale(1.04)">${cube}</g>
  </g>`);
}

const temp = mkdtempSync(join(tmpdir(), 'k8s-link-previews-'));
try {
  const source = join(temp, 'render.html');
  function rasterize(markup, output, width, height, background = 'transparent') {
    writeFileSync(source, `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:${background}}svg{display:block;width:${width}px;height:${height}px}</style>${markup}`);
    execFileSync(browser, [
      '--headless', '--no-first-run', '--disable-background-networking', '--no-default-browser-check',
      '--hide-scrollbars', '--default-background-color=00000000', `--user-data-dir=${join(temp, 'chrome')}`,
      '--force-device-scale-factor=1', `--window-size=${width},${height}`,
      `--screenshot=${output}`, pathToFileURL(source).href,
    ], { stdio: 'pipe' });
  }

  rasterize(icon, join(temp, 'favicon.png'), 32, 32);
  rasterize(icon, join(temp, 'apple-touch-icon.png'), 180, 180, paper);

  for (const [i, [slug, title, tagline, accent]] of tools.entries()) {
    const assets = fileURLToPath(new URL(`../../apps/${slug}/public/`, import.meta.url));
    writeFileSync(join(assets, 'favicon.svg'), icon);
    for (const filename of ['favicon.png', 'apple-touch-icon.png']) {
      copyFileSync(join(temp, filename), join(assets, filename));
    }
    rasterize(card(i + 1, title, tagline, accent), join(assets, 'link-preview.png'), 1200, 630);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
