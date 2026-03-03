export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Try serving static asset first
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404) {
      return response;
    }

    // If 404, try clean URL: /aisha -> serve masjid.html content
    // getMasjidId() in masjid.html reads the slug from the URL path
    const segment = path.replace(/^\//, '').replace(/\/$/, '');
    if (segment && !segment.includes('.') && !segment.includes('/')) {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = '/masjid.html';
      let res = await env.ASSETS.fetch(assetUrl.toString());

      // Follow redirect if Cloudflare strips .html
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('Location');
        if (loc) {
          res = await env.ASSETS.fetch(new URL(loc, assetUrl).toString());
        }
      }

      // Return content at the clean URL
      return new Response(res.body, {
        status: 200,
        headers: res.headers
      });
    }

    return response;
  }
};
