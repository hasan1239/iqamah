export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Clean URL: /aisha -> serve masjid.html with ?id=aisha
    const segment = path.replace(/^\//, '').replace(/\/$/, '');
    if (segment && !segment.includes('.') && !segment.includes('/')) {
      const newUrl = new URL(request.url);
      newUrl.pathname = '/masjid.html';
      newUrl.searchParams.set('id', segment);
      return env.ASSETS.fetch(new Request(newUrl, request));
    }

    return env.ASSETS.fetch(request);
  }
};
