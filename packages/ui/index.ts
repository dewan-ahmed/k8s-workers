export { appendCartoonTheme, cartoonStylesheet } from './cartoon';

export const siteFooter = `<nav aria-label="Kubernetes tools">Tools:
  <a href="https://deprecations.k8s.workers.dev">API deprecations</a> ·
  <a href="https://compat.k8s.workers.dev">Cluster compatibility</a> ·
  <a href="https://schema.k8s.workers.dev">Schema validation</a>
</nav>
<p class="site-credit">Built with ❤️ and 🤖 by <a href="https://www.linkedin.com/in/diahmed/" target="_blank" rel="noopener">Dewan Ahmed</a></p>`;

export function appendSiteFooter(response: Response) {
  const page = new HTMLRewriter()
    .on('footer', { element(footer) { footer.append(siteFooter, { html: true }); } })
    .transform(response);
  page.headers.delete('ETag');
  return page;
}
