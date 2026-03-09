// CSV parsing and date utilities — extracted from masjid.html

export function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
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
  // "18 Feb" → Date object (assumes 2026)
  const months = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
  };
  const parts = dateStr.trim().split(/\s+/);
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
