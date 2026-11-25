/** A shared, self-contained cartoon skin. The tools keep their own forms and behavior. */
export const cartoonStyles = `
:root {
  color-scheme: light;
  --bg: #fbf8ef; --panel: #fffef9; --input: #faf9f4; --border: #292d29;
  --text: #292d29; --muted: #5c635c; --accent: #324c38;
  --removed: #a52e38; --deprecated: #785009; --error: #a52e38; --warning: #785009;
  font-family: 'Trebuchet MS', ui-rounded, system-ui, sans-serif; line-height: 1.55;
}
body { background: var(--bg); background-image: radial-gradient(#d9d6ca 0.7px, transparent 0.7px); background-size: 14px 14px; }
a { color: #365c43; text-decoration-thickness: 1.5px; }
a:hover { color: #111; }
:focus-visible { outline: 3px solid #3559a1; outline-offset: 4px; }
.shell { width: min(100% - 3rem, 68rem); }
.topbar { background: #fffef9; border-bottom: 2px solid var(--border); }
.topbar-inner { min-height: 76px; gap: 1.5rem; flex-wrap: wrap; padding-block: 1rem; }
.brand { font-size: 1.1rem; font-weight: 850; letter-spacing: -.045em; white-space: nowrap; }
.brand-icon, .brand > span { display: inline-grid; place-items: center; color: var(--text); background: #ffe279; border: 2px solid var(--border); border-radius: 9px; width: 31px; height: 31px; margin-right: .4rem; transform: rotate(-8deg); }
.topbar-inner > a { margin-left: auto; color: var(--text); font-size: .8rem; font-weight: 700; }
.tool-nav { display: flex; gap: .25rem; align-items: center; }
.tool-nav a { text-decoration: none; color: var(--text); font-size: .8rem; font-weight: 750; padding: .45rem .7rem; border: 1.5px solid transparent; border-radius: 7px; }
.tool-nav a[aria-current='page'] { background: #ffe279; border-color: var(--border); box-shadow: 2px 2px 0 var(--border); }
.tool-nav a:hover { background: #f2eee0; }
.intro { position: relative; min-height: 290px; margin-block: 2.75rem 2.25rem; padding-block: .75rem; padding-right: 340px; }
.eyebrow { color: #4a554b; font-family: inherit; font-size: .7rem; font-weight: 850; letter-spacing: .13em; margin-bottom: .85rem; }
.intro > .eyebrow { display: inline-block; border: 1.5px solid var(--border); padding: .3rem .65rem; border-radius: 100px; background: #e5eeda; transform: rotate(-2deg); }
h1 { color: var(--text); font-size: clamp(2.7rem, 5.3vw, 4.2rem); font-weight: 900; line-height: 1.02; letter-spacing: -.065em; }
h1 span { color: var(--text); position: relative; z-index: 0; white-space: normal; }
h1 span::after { content: ''; position: absolute; inset: 68% -.05em 0; background: #ffdf75; z-index: -1; transform: rotate(-1deg); }
.intro > p:last-of-type { margin-top: 1.25rem; max-width: 38rem; font-size: .98rem; line-height: 1.65; color: #555e56; }
.tool-illustration { position: absolute; width: 300px; height: 280px; right: 4px; top: 0; pointer-events: none; }
.tool-illustration svg { width: 100%; height: 100%; overflow: visible; }
.panel { background: var(--panel); border: 2px solid var(--border); border-radius: 15px; box-shadow: 5px 5px 0 var(--border); padding: 1.75rem 2rem; margin-bottom: 1.6rem; }
.panel-heading, .section-heading { gap: 1.5rem; align-items: center; }
.panel-heading .eyebrow { margin-bottom: .35rem; }
h2 { font-size: 1.45rem; letter-spacing: -.04em; font-weight: 850; }
h3 { letter-spacing: -.02em; }
label { font-size: .82rem; font-weight: 750; }
.version { gap: .35rem; }
.version .hint { font-size: .73rem; }
button, input, select, textarea { color: var(--text); }
select, input:not([type='radio']), textarea { background: var(--input); border: 1.5px solid var(--border); border-radius: 8px; padding: .65rem .85rem; }
select { min-height: 44px; background-color: #fffdf7; font-weight: 700; }
textarea { font-family: ui-monospace, 'SFMono-Regular', Consolas, monospace; font-size: .82rem; line-height: 1.7; min-height: 170px; margin-top: .5rem; background: #f7f7f0; tab-size: 2; }
textarea::placeholder { color: #777e73; opacity: 1; }
.mode { margin: 1.25rem 0; gap: .6rem; }
.mode span { color: #555e56; border: 1.5px solid var(--border); border-radius: 7px; padding: .5rem 1rem; background: #fffef9; font-size: .82rem; }
.mode input:checked + span { color: var(--text); background: #e5eeda; border-color: var(--border); box-shadow: 2px 2px 0 var(--border); }
.mode input:focus-visible + span { outline: 3px solid #3559a1; outline-offset: 4px; }
.hint { color: var(--muted); font-size: .76rem; line-height: 1.6; }
.primary, .secondary { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; border: 2px solid var(--border); border-radius: 8px; padding: .65rem 1.15rem; font-size: .85rem; font-weight: 850; box-shadow: 3px 3px 0 var(--border); transition: transform .12s, box-shadow .12s; }
.primary { color: var(--text); background: #ffdc6b; }
.secondary { color: var(--text); background: #fffef9; }
.primary:hover:not(:disabled), .secondary:hover:not(:disabled) { transform: translate(-1px, -1px); box-shadow: 4px 4px 0 var(--border); }
.primary:active:not(:disabled), .secondary:active:not(:disabled) { transform: translate(2px, 2px); box-shadow: 1px 1px 0 var(--border); }
button:disabled { opacity: .55; }
.check-actions, .actions { gap: .85rem; margin-top: 1.2rem; flex-wrap: wrap; }
.primary span { margin-left: 1.25rem; }
.link-button { color: #365c43; }
.status:not(:empty) { color: #49554a; }
.status.error { color: var(--removed); }
.metrics { gap: .85rem; margin-block: 1.25rem; }
.metrics div { background: #eaf0e2; border: 1.5px solid var(--border); border-radius: 9px; padding: .85rem 1rem; }
.metrics div:nth-child(2) { background: #ffebe3; }
.metrics div:nth-child(3) { background: #fff2cd; }
.metrics strong { font-size: 1.9rem; letter-spacing: -.05em; }
.metrics span { font-size: .75rem; color: #4e574f; }
.badge, .target-tag { border: 1.5px solid var(--border); border-radius: 5px; background: #f6f1df; padding: .25rem .5rem; }
.finding { border-color: #c8ccbf; padding-block: 1rem; }
.finding p { line-height: 1.65; }
.overview section { background: #edf0e5; border: 1.5px solid #929a89; border-radius: 8px; padding: 1rem; }
.finding h3 { font-size: .85rem; }
details { border: 1.5px solid #929a89; background: #fff8e5; border-radius: 8px; padding: .85rem; }
summary { color: #684b16; font-size: .84rem; font-weight: 700; }
.email-form { border-color: #c8ccbf; }
.ci-docs { box-shadow: 3px 3px 0 #b9bdb0; border-color: #9ba28f; background: #f5f4ea; }
.ci-docs p { font-size: .85rem; }
.ci-docs pre { background: #eaece2; border: 1px solid #bcc3b1; color: #334335; border-radius: 7px; font-size: .78rem; }
footer { color: var(--muted); font-size: .78rem; padding-bottom: 2rem; margin-top: 1.75rem; }
.site-credit { margin-top: 1.25rem; padding-top: 1rem; border-top: 1.5px solid #b5bcaa; font-size: .8rem; }
.site-credit a { color: var(--text); font-weight: 800; }
.sibling-tools { display: flex; flex-wrap: wrap; gap: .5rem 1.25rem; }
@media (prefers-reduced-motion: reduce) { .primary, .secondary { transition: none; } }
@media (max-width: 800px) {
  .intro { padding-right: 230px; min-height: 250px; }
  .tool-illustration { width: 225px; height: 240px; top: 15px; right: -10px; }
  h1 { font-size: clamp(2.5rem, 6vw, 3.5rem); }
  .topbar-inner { gap: 1rem; }
  .topbar-inner > a { display: none; }
  .tool-nav { margin-left: auto; }
}
@media (max-width: 580px) {
  .shell { width: calc(100% - 2rem); }
  .topbar-inner { min-height: 0; padding-block: .9rem; gap: .85rem; }
  .brand { font-size: 1rem; }
  .tool-nav { width: 100%; margin: 0; gap: .4rem; }
  .tool-nav a { flex: 1; padding: .4rem .35rem; text-align: center; font-size: .75rem; }
  .intro { padding: .25rem 0 0; min-height: 0; margin-block: 1.7rem 1.5rem; }
  .intro > .eyebrow { font-size: .6rem; margin-bottom: .9rem; }
  h1 { font-size: 2.9rem; max-width: 100%; }
  .intro > p:last-of-type { font-size: .88rem; margin-top: 1rem; }
  .tool-illustration { display: none; }
  .panel { padding: 1.15rem; border-radius: 11px; box-shadow: 3px 3px 0 var(--border); }
  .panel-heading, .section-heading { align-items: flex-start; flex-direction: column; gap: 1rem; }
  .version { width: 100%; }
  h2 { font-size: 1.3rem; }
  .eyebrow { font-size: .6rem; }
  select { width: 100%; }
  textarea { min-height: 165px; font-size: .75rem; }
  .mode { margin-block: 1rem; }
  .mode label { flex: 1; }
  .mode span { text-align: center; padding: .5rem .35rem; font-size: .76rem; }
  .check-actions, .actions { display: flex; }
  .check-actions button, .actions button { flex: 1; padding-inline: .65rem; }
  .primary, .secondary { font-size: .76rem; }
  .metrics { gap: .45rem; }
  .metrics div { padding: .55rem; }
  .metrics strong { font-size: 1.5rem; }
  .metrics span { font-size: .65rem; }
}
`;

// Original vector illustration: a small cluster companion inspecting a manifest.
const illustration = `<div class="tool-illustration" aria-hidden="true"><svg viewBox="0 0 320 290" fill="none" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="164" cy="257" rx="114" ry="12" fill="#e6e4d7"/>
  <path d="M38 130C20 61 88 21 161 29c75 8 150 82 122 151-27 68-197 70-245-50Z" fill="#e5ecda"/>
  <path d="m266 31 5 12 13 1-10 8 3 13-11-7-11 7 3-13-10-8 13-1 5-12Z" fill="#ffda6d" stroke="#292d29" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M42 203h-15m8-8v16M290 123h-13m7-7v14" stroke="#292d29" stroke-width="2.5" stroke-linecap="round"/>
  <g transform="rotate(9 229 111)"><rect x="190" y="64" width="79" height="98" rx="9" fill="#292d29"/><rect x="185" y="59" width="79" height="98" rx="9" fill="#fffdf7" stroke="#292d29" stroke-width="2.5"/><path d="m199 79 4 4 7-8m-11 24 4 4 7-8m-11 24 4 4 7-8" stroke="#48704b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M221 80h26m-26 20h21m-21 20h26m-48 20h48" stroke="#9ca68d" stroke-width="3" stroke-linecap="round"/></g>
  <path d="m121 218-8 28m62-28 10 28" stroke="#292d29" stroke-width="7" stroke-linecap="round"/><path d="M101 248h14m68 0h15" stroke="#292d29" stroke-width="7" stroke-linecap="round"/>
  <path d="M81 157c-20 0-25 15-24 24m150-25c19 2 25-10 27-18" stroke="#292d29" stroke-width="6" stroke-linecap="round"/>
  <path d="m83 113 58-31 64 31v87l-61 32-61-33v-86Z" fill="#ffdc6b" stroke="#292d29" stroke-width="3" stroke-linejoin="round"/>
  <path d="m83 113 61 32 61-32m-61 32v87" stroke="#292d29" stroke-width="3" stroke-linejoin="round"/>
  <path d="m145 146 59-31v84l-59 31v-84Z" fill="#e7b94f"/>
  <path d="m109 122 60-30" stroke="#292d29" stroke-width="3"/>
  <ellipse cx="103" cy="160" rx="4" ry="6" fill="#292d29"/><ellipse cx="129" cy="174" rx="4" ry="6" fill="#292d29"/>
  <path d="M105 185c5 9 11 12 17 9" stroke="#292d29" stroke-width="3" stroke-linecap="round"/>
  <ellipse cx="97" cy="175" rx="7" ry="4" transform="rotate(25 97 175)" fill="#efa58a"/>
  <path d="m165 165 20-10 10 18-10 22-20-1-10-17 10-12Z" fill="#fff5cf" stroke="#292d29" stroke-width="2"/><path d="m175 164v21m-9-14 18 8m-18 6 18-23" stroke="#292d29" stroke-width="2" stroke-linecap="round"/>
  <path d="M57 56c0-11 9-20 20-20h90c11 0 20 9 20 20v13c0 11-9 20-20 20H99L83 103V89h-6c-11 0-20-9-20-20V56Z" fill="#fffdf7" stroke="#292d29" stroke-width="2.5" stroke-linejoin="round"/>
  <text x="122" y="68" text-anchor="middle" fill="#292d29" font-family="'Trebuchet MS',sans-serif" font-size="14" font-weight="800">let’s check it!</text>
</svg></div>`;

const tools = [
  ['deprecations', 'Deprecations'],
  ['compat', 'Compatibility'],
  ['schema', 'Schema'],
] as const;

export type Tool = typeof tools[number][0];

/** Serve from the tool's origin so the existing self-only CSP remains intact. */
export function cartoonStylesheet() {
  return new Response(cartoonStyles, { headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' } });
}

/** Append after the tool's stylesheet so the same theme covers every workspace. */
export function appendCartoonTheme(response: Response, currentTool: Tool) {
  if (!response.headers.get('Content-Type')?.includes('text/html')) return response;
  const navigation = `<nav class="tool-nav" aria-label="Kubernetes tools">${tools.map(([slug, label]) =>
    `<a href="https://${slug}.k8s.workers.dev"${slug === currentTool ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
  const page = new HTMLRewriter()
    .on('head', { element(head) { head.append('<link rel="stylesheet" href="/cartoon.css">', { html: true }); } })
    .on('.topbar-inner', { element(topbar) { topbar.append(navigation, { html: true }); } })
    .on('.intro', { element(intro) { intro.append(illustration, { html: true }); } })
    .transform(response);
  page.headers.delete('ETag');
  page.headers.delete('Content-Length');
  return page;
}
