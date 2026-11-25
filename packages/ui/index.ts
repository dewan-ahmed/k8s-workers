export const siteFooter = '<p class="site-credit">Built with ❤️ and 🤖 by <a href="https://www.linkedin.com/in/diahmed/" target="_blank" rel="noopener">Dewan Ahmed</a></p>';

export function appendSiteFooter(response: Response) {
  const page = new HTMLRewriter()
    .on('footer', { element(footer) { footer.append(siteFooter, { html: true }); } })
    .transform(response);
  page.headers.delete('ETag');
  return page;
}
