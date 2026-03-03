export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Try serving static asset first
    const response = await env.ASSETS.fetch(request);

    // If found, return it
    if (response.status !== 404) {
      return response;
    }

    // If 404, try clean URL: /aisha -> serve masjid.html with ?id=aisha
    const segment = path.replace(/^\//, '').replace(/\/$/, '');
    if (segment && !segment.includes('.') && !segment.includes('/')) {
      const newUrl = new URL(request.url);
      newUrl.pathname = '/masjid.html';
      newUrl.searchParams.set('id', segment);
      return env.ASSETS.fetch(new Request(newUrl, request));
    }

    return response;
  }
};
