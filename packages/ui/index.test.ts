import { expect, it } from 'vitest';
import { siteFooter } from './index';

it('credits Dewan Ahmed and securely opens his LinkedIn profile in a new tab', () => {
  expect(siteFooter).toContain('Built with ❤️ and 🤖 by <a href="https://www.linkedin.com/in/diahmed/" target="_blank" rel="noopener">Dewan Ahmed</a>');
});

it('links all three Kubernetes tools from the shared footer', () => {
  for (const tool of ['deprecations', 'compat', 'schema']) {
    expect(siteFooter).toContain(`href="https://${tool}.k8s.workers.dev"`);
  }
});
