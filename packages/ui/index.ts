export const siteFooter = '<p class="site-credit">Built with ❤️ and 🤖 by <a href="https://www.linkedin.com/in/diahmed/" target="_blank" rel="noopener">Dewan Ahmed</a></p><nav aria-label="More Kubernetes tools"><a href="https://deprecations.k8s.workers.dev">Deprecations</a><a href="https://compat.k8s.workers.dev">Compatibility</a><a href="https://schema.k8s.workers.dev">Schema</a></nav>';

export function appendSiteFooter(response: Response) {
  const page = new HTMLRewriter()
    .on('footer', { element(footer) { footer.append(siteFooter, { html: true }); } })
    .transform(response);
  page.headers.delete('ETag');
  return page;
}
