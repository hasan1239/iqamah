// Prayer countdown timer utilities — extracted from masjid.html

export function parseTimeToDate(timeStr) {
  // "5:30" or "17:30" or "5:30 PM" → Date object for today
  if (!timeStr || timeStr === '-') return null;
  const clean = timeStr.trim().toUpperCase();
  const match = clean.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/);
  if (!match) return null;

  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  const ampm = match[3];

  if (ampm === 'PM' && hours >= 1 && hours <= 11) hours += 12;
  if (ampm === 'AM' && hours === 12) hours = 0;

  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
}

export function formatCountdown(ms) {
  if (ms <= 0) return null;
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

export function getNextPrayer(prayers, now) {
  // prayers = [{ name, time (Date) }]
  // Returns { name, time, countdown } or null
  if (!now) now = new Date();

  for (const prayer of prayers) {
    if (!prayer.time) continue;
    const diff = prayer.time.getTime() - now.getTime();
    if (diff > 0) {
      return {
        name: prayer.name,
        time: prayer.time,
        countdown: formatCountdown(diff),
      };
    }
  }
  return null;
}

export function formatTime(timeStr, use24Hour) {
  if (!timeStr || timeStr === '-') return timeStr;
  if (use24Hour) return timeStr; // Already in 24h format from CSV

  // Convert 24h to 12h if needed
  const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return timeStr;

  let hours = parseInt(match[1]);
  const minutes = match[2];

  if (hours === 0) return '12:' + minutes + ' AM';
  if (hours < 12) return hours + ':' + minutes + ' AM';
  if (hours === 12) return '12:' + minutes + ' PM';
  return (hours - 12) + ':' + minutes + ' PM';
}
