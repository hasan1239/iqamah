// Postcode lookup — Postcodes.io (free, no API key; already attributed in
// Settings). Used by the Masjids view as a no-permission alternative to
// geolocation: a typed postcode/outcode becomes the active location source.

const API_BASE = 'https://api.postcodes.io';

// Full UK postcode with or without the space, e.g. "B12 0XS" / "b120xs".
const FULL_POSTCODE_RE = /^([A-Za-z]{1,2}\d[A-Za-z\d]?)(\d[A-Za-z]{2})$/;
// Outcode only, e.g. "M14", "B12", "SW1A".
const OUTCODE_RE = /^[A-Za-z]{1,2}\d[A-Za-z\d]?$/;

// Decide whether a search query is shaped like a UK postcode or outcode.
// Returns null when it isn't, otherwise:
//   { kind: 'postcode' | 'outcode', api, display, outcode }
export function parsePostcodeQuery(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const compact = raw.trim().replace(/\s+/g, '');
  if (compact.length < 2 || compact.length > 7) return null;

  const full = compact.match(FULL_POSTCODE_RE);
  if (full) {
    const outcode = full[1].toUpperCase();
    const incode = full[2].toUpperCase();
    return {
      kind: 'postcode',
      api: outcode + incode,
      display: `${outcode} ${incode}`,
      outcode,
    };
  }

  if (OUTCODE_RE.test(compact)) {
    const outcode = compact.toUpperCase();
    return { kind: 'outcode', api: outcode, display: outcode, outcode };
  }

  return null;
}

// Resolve a parsed postcode/outcode to coordinates.
// Resolves to { lat, lon, postcode, outcode }.
// Throws an Error with .notFound === true on a 404 (unknown postcode);
// any other failure (network, timeout, 5xx) throws a plain Error so the
// caller can degrade silently.
export async function lookupPostcode(parsed, { timeoutMs = 6000 } = {}) {
  const url = parsed.kind === 'postcode'
    ? `${API_BASE}/postcodes/${encodeURIComponent(parsed.api)}`
    : `${API_BASE}/outcodes/${encodeURIComponent(parsed.api)}`;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
    if (res.status === 404) {
      const err = new Error('Postcode not found');
      err.notFound = true;
      throw err;
    }
    if (!res.ok) throw new Error(`Postcode lookup failed (${res.status})`);
    const data = await res.json();
    const result = data && data.result;
    // Some terminated/special codes come back without coordinates — treat
    // those the same as not found.
    if (!result || result.latitude == null || result.longitude == null) {
      const err = new Error('Postcode has no location');
      err.notFound = true;
      throw err;
    }
    return {
      lat: result.latitude,
      lon: result.longitude,
      postcode: parsed.kind === 'postcode' ? (result.postcode || parsed.display) : parsed.display,
      outcode: result.outcode || parsed.outcode,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
