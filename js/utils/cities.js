// City derivation shared by the Masjids and Jummah Times views.
// Extracted from js/views/masjids.js so list views group consistently.

const STREET_SUFFIX_RE = /\b(Road|Rd|Street|St|Avenue|Ave|Lane|Ln|Way|Drive|Dr|Close|Cl|Place|Pl|Court|Ct|Park|Square|Sq|Crescent|Hill|Terrace|Gardens?|Mews|Grove|Walk|Row)\b\.?$/i;
const POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;
export const OTHER_CITY = 'Other';

// UK postcode area → major city rollup. The letter(s) before the first digit
// of a postcode identify the postcode area (e.g. B = Birmingham). Mapping here
// is intentionally conservative — only major metros that we want to group as
// one. Other areas (WD/Watford, HX/Halifax, etc.) fall through to config.city.
const POSTCODE_AREA_TO_CITY = {
  // Inner London
  E: 'London', EC: 'London', N: 'London', NW: 'London',
  SE: 'London', SW: 'London', W: 'London', WC: 'London',
  // Outer London / Greater London postcode areas
  BR: 'London', CR: 'London', DA: 'London', EN: 'London',
  HA: 'London', IG: 'London', KT: 'London', RM: 'London',
  SM: 'London', TW: 'London', UB: 'London', WD: 'London',
  // Other major UK metros
  B: 'Birmingham',
  M: 'Manchester',
  G: 'Glasgow',
  L: 'Liverpool',
  BD: 'Bradford',
  LE: 'Leicester',
  LS: 'Leeds',
  CV: 'Coventry',
  WV: 'Wolverhampton',
  HX: 'Halifax',
  HD: 'Huddersfield',
  EH: 'Edinburgh',
  CF: 'Cardiff',
  NP: 'Newport',
  SA: 'Swansea',
  NG: 'Nottingham',
  BS: 'Bristol',
  S: 'Sheffield',
  SL: 'Slough',
  BB: 'Blackburn',
  PR: 'Preston',
  // Greater Manchester (Bolton, Oldham, Stockport, Wigan) → Manchester
  BL: 'Manchester', OL: 'Manchester', SK: 'Manchester', WN: 'Manchester',
  // West Midlands metropolitan county (Dudley, Walsall) → Birmingham.
  // Wolverhampton (WV) and Coventry (CV) kept separate — chartered cities.
  DY: 'Birmingham', WS: 'Birmingham',
};

// Final fallback: scan for these tokens in address / display name when no
// postcode and no explicit city.
const KNOWN_CITY_TOKENS = [
  'London', 'Birmingham', 'Manchester', 'Glasgow', 'Liverpool',
  'Bradford', 'Leicester', 'Leeds', 'Coventry', 'Bolton',
  'Blackburn', 'Halifax', 'Watford', 'Wolverhampton', 'Gloucester',
  'Smethwick', 'Batley', 'Elland', 'Halesowen',
];

export function getCityPostcode(address) {
  if (!address) return '';
  const pcMatch = address.match(/[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/i);
  if (!pcMatch) return address.split(',').pop().trim();
  const postcode = pcMatch[0];
  const before = address.slice(0, pcMatch.index).replace(/,\s*$/, '');
  const parts = before.split(',').map(s => s.trim()).filter(Boolean);
  const city = parts.length > 0 ? parts[parts.length - 1] : '';
  return city ? `${city}, ${postcode}` : postcode;
}

function normaliseCity(city) {
  if (!city) return OTHER_CITY;
  let c = city.replace(/\s+/g, ' ').trim();
  c = c.replace(/^City of\s+/i, '');
  c = c.replace(/\b(City|Borough|District)\b$/i, '').trim();
  c = c.replace(/,$/, '').trim();
  if (!c) return OTHER_CITY;
  return c.charAt(0).toUpperCase() + c.slice(1);
}

function cityFromPostcode(addr) {
  if (!addr) return null;
  const m = addr.match(POSTCODE_RE);
  if (!m) return null;
  const areaMatch = m[0].match(/^([A-Z]{1,2})/i);
  if (!areaMatch) return null;
  const area = areaMatch[1].toUpperCase();
  return POSTCODE_AREA_TO_CITY[area] || null;
}

function cityFromTokens(text) {
  if (!text) return null;
  for (const city of KNOWN_CITY_TOKENS) {
    if (new RegExp('\\b' + city + '\\b', 'i').test(text)) return city;
  }
  return null;
}

export function deriveCity(config) {
  // 1. Postcode-area rollup wins (groups London boroughs → London, B-area
  //    suburbs like Smethwick/Halesowen → Birmingham, etc.)
  const pcCity = cityFromPostcode(config.address);
  if (pcCity) return pcCity;
  // 2. Explicit city field
  if (config.city && config.city.trim()) return normaliseCity(config.city.trim());
  // 3. Known city token anywhere in address / display name
  const tokenCity = cityFromTokens(config.address) || cityFromTokens(config.display_name);
  if (tokenCity) return tokenCity;
  // 4. Last comma-separated segment of address as final fallback
  const addr = (config.address || '').trim();
  if (!addr) return OTHER_CITY;
  const withoutPC = addr.replace(POSTCODE_RE, '').replace(/[,\.\s]+$/, '').trim();
  if (!withoutPC) return OTHER_CITY;
  const parts = withoutPC.split(',').map(s => s.trim()).filter(Boolean);
  let candidate = parts.length ? parts[parts.length - 1] : withoutPC;
  candidate = candidate.replace(/\bUK\b\.?/i, '').replace(/\bGreater\b/i, '').trim();
  if (!candidate) return OTHER_CITY;
  if (parts.length <= 1 || STREET_SUFFIX_RE.test(candidate)) {
    const words = candidate.split(/\s+/).filter(Boolean);
    const last = words[words.length - 1];
    if (!last || /^(Road|Rd|Street|St|Avenue|Ave|Lane|Ln|Way|Drive|Dr|Close|Cl|Place|Pl)\.?$/i.test(last)) {
      return OTHER_CITY;
    }
    return normaliseCity(last);
  }
  return normaliseCity(candidate);
}
