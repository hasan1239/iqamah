// Masjid index loader for list/map/home views.
// Prefers the slim companion index (~3.5x smaller than index.json) and falls
// back to the full index if the slim file is missing (mid-deploy, forks).
// Detail views (prayer-times, update) keep fetching /data/mosques/{slug}.json;
// the admin dashboard keeps the full index (it needs quality.warnings/issues).
export async function loadMasjidIndex() {
  for (const url of ['/data/mosques/index-slim.json', '/data/mosques/index.json']) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      return await res.json();
    } catch { /* try next */ }
  }
  throw new Error('Masjid index unavailable');
}
