// Admin mode utilities — checks if the current user is admin via server verification

const CACHE_KEY = 'iqamah-admin';

export async function isAdmin() {
  const userName = localStorage.getItem('iqamah-user-name');
  if (!userName) return false;

  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached !== null) return cached === '1';

  try {
    const resp = await fetch('/api/admin/verify', {
      headers: { 'X-User-Name': userName },
    });
    const data = await resp.json();
    const admin = data.admin === true;
    sessionStorage.setItem(CACHE_KEY, admin ? '1' : '0');
    return admin;
  } catch {
    return false;
  }
}

export function clearAdminCache() {
  sessionStorage.removeItem(CACHE_KEY);
}

export function getAdminHeaders() {
  const headers = {};
  const userName = localStorage.getItem('iqamah-user-name');
  if (userName) headers['X-User-Name'] = userName;
  return headers;
}
