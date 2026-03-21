/**
 * Gregorian-to-Hijri date converter using the browser's Intl API
 * with the Umm al-Qura calendar (used in Saudi Arabia, generally
 * matches observed Islamic dates well).
 */

const HIJRI_MONTHS = [
  'Muharram', 'Safar', "Rabi' al-Awwal", "Rabi' al-Thani",
  "Jumada al-Ula", "Jumada al-Thani", 'Rajab', "Sha'ban",
  'Ramadan', 'Shawwal', "Dhul Qa'dah", 'Dhul Hijjah'
];

const HIJRI_MONTHS_SHORT = [
  'Muh', 'Saf', 'Rab I', 'Rab II',
  'Jum I', 'Jum II', 'Raj', 'Sha',
  'Ram', 'Shaw', 'Dhul Q', 'Dhul H'
];

const hijriFormatter = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
});

/**
 * Convert a Gregorian date to Hijri date.
 * @param {Date} date - Gregorian date
 * @returns {{ day: number, month: number, year: number, monthName: string, monthShort: string }}
 */
export function gregorianToHijri(date) {
  const parts = hijriFormatter.formatToParts(date);
  const day = parseInt(parts.find(p => p.type === 'day').value);
  const month = parseInt(parts.find(p => p.type === 'month').value);
  const year = parseInt(parts.find(p => p.type === 'year').value);

  return {
    day,
    month,
    year,
    monthName: HIJRI_MONTHS[month - 1] || '',
    monthShort: HIJRI_MONTHS_SHORT[month - 1] || ''
  };
}

/**
 * Format a Gregorian date as a full Hijri date string.
 * @param {Date} date - Gregorian date
 * @returns {string} e.g. "26 Shawwal 1447"
 */
export function formatHijriDate(date) {
  const h = gregorianToHijri(date);
  return `${h.day} ${h.monthName} ${h.year}`;
}
