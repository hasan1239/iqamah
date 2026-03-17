// Eid Times view — list all masjids with Eid salah times, sorted by earliest

const MOSQUE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c-.4.6-.8 1.3-.6 2 .1.4.6.6.6.6s.5-.2.6-.6c.2-.7-.2-1.4-.6-2z"/><path d="M12 4.5C9.5 6.5 7 9 7 11.5c0 0 0 .5.2.5H16.8c.2 0 .2-.5.2-.5 0-2.5-2.5-5-5-7z"/><rect x="5" y="12" width="14" height="9"/><path d="M12 21v-5a2.5 2.5 0 0 0-2.5-2.5h0A2.5 2.5 0 0 0 7 16v5"/><rect x="2" y="10" width="3" height="11" rx=".5"/><rect x="19" y="10" width="3" height="11" rx=".5"/></svg>';

function parseEidTimes(str) {
  if (!str) return { times: [], earliest: Infinity, raw: '' };
  const regex = /(\d{1,2}(?::\d{2})?)\s*(am|pm)/gi;
  const times = [];
  let match;
  while ((match = regex.exec(str)) !== null) {
    let [h, m] = match[1].includes(':')
      ? match[1].split(':').map(Number) : [Number(match[1]), 0];
    const isPM = match[2].toLowerCase() === 'pm';
    if (isPM && h !== 12) h += 12;
    if (!isPM && h === 12) h = 0;
    times.push({ time: match[0], minutes: h * 60 + m });
  }
  times.sort((a, b) => a.minutes - b.minutes);
  return { times, earliest: times.length > 0 ? times[0].minutes : Infinity, raw: str };
}

function getCityPostcode(address) {
  if (!address) return '';
  const pcMatch = address.match(/[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/i);
  if (!pcMatch) return address.split(',').pop().trim();
  const before = address.slice(0, pcMatch.index).replace(/,\s*$/, '');
  const parts = before.split(',').map(s => s.trim()).filter(Boolean);
  const city = parts.length > 0 ? parts[parts.length - 1] : '';
  return city ? `${city}, ${pcMatch[0]}` : pcMatch[0];
}

export async function render(container) {
  container.innerHTML = `
    <div class="eid-times-view">
      <header class="eid-times-header">
        <h1>Eid Salah Times</h1>
        <p class="eid-times-subtitle">All masjids sorted by earliest jama'at</p>
        <p class="eid-times-hint">See Masjid Info for more details</p>
      </header>
      <div class="eid-times-loading">
        <div class="skeleton-bone" style="width:100%;height:80px;border-radius:14px;margin-bottom:12px"></div>
        <div class="skeleton-bone" style="width:100%;height:80px;border-radius:14px;margin-bottom:12px"></div>
        <div class="skeleton-bone" style="width:100%;height:80px;border-radius:14px"></div>
      </div>
    </div>`;

  try {
    const res = await fetch('/data/mosques/index.json');
    if (!res.ok) return;
    const configs = await res.json();

    // Filter: non-empty eid_salah, exclude test masjids
    const withEid = configs
      .filter(c => !c.test_masjid && c.eid_salah && c.eid_salah.trim())
      .map(c => ({ config: c, parsed: parseEidTimes(c.eid_salah) }))
      .sort((a, b) => a.parsed.earliest - b.parsed.earliest);

    const listEl = container.querySelector('.eid-times-loading');
    if (!listEl) return;

    if (withEid.length === 0) {
      listEl.innerHTML = `<div class="eid-times-empty">No Eid salah times available yet.</div>`;
      return;
    }

    listEl.className = 'eid-times-list';
    listEl.innerHTML = withEid.map(({ config: c, parsed }) => {
      const pills = parsed.times.map(t => `<span class="eid-time-pill">${t.time}</span>`).join('');
      const addr = c.address ? `<div class="eid-card-address">${getCityPostcode(c.address)}</div>` : '';
      return `
        <a href="/${c.slug}" class="eid-card" data-link>
          <div class="eid-card-content">
            <div class="eid-card-name">${c.display_name}</div>
            ${addr}
            <div class="eid-card-pills">${pills}</div>
          </div>
        </a>`;
    }).join('');
  } catch (err) {
    console.error('Error loading eid times:', err);
  }
}

export function destroy() {}
