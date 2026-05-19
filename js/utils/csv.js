// CSV parsing and date utilities — extracted from masjid.html

// Mawaqit's snake_case headers normalised to legacy title-case for shared use.
const HEADER_ALIASES = {
  'date': 'Date', 'day': 'Day', 'islamic_day': 'Islamic Day',
  'sehri_ends': 'Sehri Ends', 'fajr_start': 'Fajr Start',
  'sunrise': 'Sunrise', 'zawal': 'Zawal', 'zohr': 'Zohr', 'asr': 'Asr', 'esha': 'Esha',
  'fajr_jamaat': "Fajr Jama'at", 'zohar_jamaat': "Zohar Jama'at",
  'asr_jamaat': "Asr Jama'at", 'maghrib_iftari': 'Maghrib Iftari',
  'maghrib_jamaat': "Maghrib Jama'at", 'esha_jamaat': "Esha Jama'at",
};

export function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => {
    const trimmed = h.trim();
    return HEADER_ALIASES[trimmed] || trimmed;
  });
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',').map(v => v.trim());
    if (vals.length < headers.length) continue;
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = vals[j] || '';
    }
    rows.push(row);
  }
  return rows;
}

export function parseDate(dateStr) {
  if (!dateStr) return null;
  const trimmed = dateStr.trim();
  // ISO format from fetch_mawaqit.py: "2026-05-19"
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return new Date(parseInt(isoMatch[1]), parseInt(isoMatch[2]) - 1, parseInt(isoMatch[3]));
  }
  // Legacy image-extraction format: "18 Feb" (assumes 2026)
  const months = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
  };
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return null;
  const day = parseInt(parts[0]);
  const mon = months[parts[1]];
  if (isNaN(day) || mon === undefined) return null;
  return new Date(2026, mon, day);
}

export function getTodayRow(csvData) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (const row of csvData) {
    const dateStr = row['Date'] || row['date'] || '';
    const d = parseDate(dateStr);
    if (d && d.getTime() === today.getTime()) return row;
  }
  return null;
}

export function getTomorrowRow(csvData) {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  for (const row of csvData) {
    const dateStr = row['Date'] || row['date'] || '';
    const d = parseDate(dateStr);
    if (d && d.getTime() === tomorrow.getTime()) return row;
  }
  return null;
}

export function getColumnValue(row, columnName, columnsMap) {
  // Look up value using optional column name mapping
  if (columnsMap && columnsMap[columnName]) {
    return row[columnsMap[columnName]] || '';
  }
  return row[columnName] || '';
}
