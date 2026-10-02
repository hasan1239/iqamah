// Loads a masjid's timetable rows. Live-feed masjids (Mawaqit, MasjidBox...)
// can also have an uploaded backup timetable (config.backup_csv, written by
// /api/update): feed rows always win, and backup rows only fill dates the
// feed has no row for. Backup rows are tagged with row._backup = true.

import { parseCSV, parseDate } from './csv.js';

async function fetchRows(path) {
  try {
    const res = await fetch(`/data/${path}`);
    if (!res.ok) return null;
    return parseCSV(await res.text());
  } catch {
    return null;
  }
}

function dateKey(row) {
  const d = parseDate(row['Date'] || row['date'] || '');
  return d ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : null;
}

// Pure merge, exported for tests
export function mergeBackupRows(mainRows, backupRows) {
  if (!backupRows || backupRows.length === 0) return mainRows || [];
  const main = mainRows || [];
  const have = new Set(main.map(dateKey).filter(Boolean));
  const extra = [];
  for (const row of backupRows) {
    const key = dateKey(row);
    if (!key || have.has(key)) continue;
    have.add(key);
    extra.push({ ...row, _backup: true });
  }
  if (extra.length === 0) return main;
  const time = (row) => {
    const d = parseDate(row['Date'] || row['date'] || '');
    return d ? d.getTime() : Infinity;
  };
  return [...main, ...extra].sort((a, b) => time(a) - time(b));
}

// Returns the merged rows, or null if neither the main nor the backup CSV
// could be loaded (callers treat null like a failed fetch).
export async function loadMasjidRows(config) {
  const csvFile = config.csv || config.slug + '.csv';
  const [mainRows, backupRows] = await Promise.all([
    fetchRows(csvFile),
    config.backup_csv ? fetchRows(config.backup_csv) : Promise.resolve(null),
  ]);
  if (mainRows === null && backupRows === null) return null;
  return mergeBackupRows(mainRows, backupRows);
}
