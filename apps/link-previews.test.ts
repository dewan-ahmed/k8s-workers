import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { unstable_dev } from 'wrangler';

it.each(['deprecations', 'compat', 'schema'])('%s serves its link preview and icons from the same site', async (tool) => {
  const directory = new URL(`./${tool}/`, import.meta.url);
  const worker = await unstable_dev(fileURLToPath(new URL('worker.ts', directory)), {
    config: fileURLToPath(new URL('wrangler.jsonc', directory)),
    logLevel: 'none',
    persist: false,
    experimental: { disableDevRegistry: true, disableExperimentalWarning: true, watch: false },
  });

  try {
    const origin = `https://${tool}.k8s.workers.dev`;
    const page = await worker.fetch('/', { headers: { 'User-Agent': 'Twitterbot/1.0' } });
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    const head = /<head>([\s\S]*?)<\/head>/.exec(await page.text())?.[1];
    expect(head).toBeDefined();
    const title = /<title>([^<]+)<\/title>/.exec(head!)?.[1];
    const description = /<meta name="description" content="([^"]+)">/.exec(head!)?.[1];
    for (const [property, content] of Object.entries({
      'og:type': 'website',
      'og:url': `${origin}/`,
      'og:title': title,
      'og:description': description,
      'og:image': `${origin}/link-preview.png`,
      'og:image:type': 'image/png',
      'og:image:width': '1200',
      'og:image:height': '630',
    })) {
      expect(head).toContain(`<meta property="${property}" content="${content}">`);
    }
    expect(head).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(head).toContain(`<meta name="twitter:image" content="${origin}/link-preview.png">`);
    expect(head).toContain('<link rel="icon" href="/favicon.svg"');
    expect(head).toContain('<link rel="icon" href="/favicon.png"');
    expect(head).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png"');

    for (const [path, type, width, height] of [
      ['/favicon.svg', 'image/svg+xml'],
      ['/favicon.png', 'image/png', 32, 32],
      ['/apple-touch-icon.png', 'image/png', 180, 180],
      ['/link-preview.png', 'image/png', 1200, 630],
    ] as const) {
      const [image, headersOnly] = await Promise.all([
        worker.fetch(path),
        worker.fetch(path, { method: 'HEAD' }),
      ]);
      for (const response of [image, headersOnly]) {
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toBe(type);
        expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
      }
      expect(await headersOnly.text()).toBe('');
      if (type === 'image/png') {
        const png = Buffer.from(await image.arrayBuffer());
        expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([width, height]);
      } else {
        expect(await image.text()).toMatch(/^<svg[\s>]/);
      }
    }
  } finally {
    await worker.stop();
  }
}, 30000);
