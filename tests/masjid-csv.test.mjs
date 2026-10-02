// Tests for js/utils/masjid-csv.js: live-feed rows merged with an uploaded
// backup timetable. Run: node --test tests/masjid-csv.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mergeBackupRows, loadMasjidRows } from '../js/utils/masjid-csv.js';

const FEED_CSV = [
  'date,day,fajr_jamaat',
  '2026-10-01,Thu,06:00',
  '2026-10-02,Fri,06:01',
].join('\n');

const BACKUP_CSV = [
  "Date,Day,Fajr Jama'at",
  '2 Oct,Fri,9:99',   // overlaps the feed: feed must win
  '3 Oct,Sat,6:30',   // gap in the feed: backup fills it
].join('\n');

let served;
beforeEach(() => {
  served = {};
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^\/data\//, '');
    return path in served
      ? new Response(served[path])
      : new Response('Not found', { status: 404 });
  };
});

test('mergeBackupRows: feed rows win, backup fills gaps, result is date-sorted and tagged', () => {
  const feed = [{ Date: '2026-10-02', x: 'feed2' }, { Date: '2026-10-01', x: 'feed1' }];
  const backup = [{ Date: '2 Oct', x: 'backup2' }, { Date: '3 Oct', x: 'backup3' }, { Date: '30 Sep', x: 'backup0' }];
  const rows = mergeBackupRows(feed, backup);
  assert.deepEqual(rows.map(r => r.x), ['backup0', 'feed1', 'feed2', 'backup3']);
  assert.equal(rows.find(r => r.x === 'backup3')._backup, true);
  assert.equal(rows.find(r => r.x === 'feed2')._backup, undefined);
});

test('mergeBackupRows: no backup returns the feed rows unchanged', () => {
  const feed = [{ Date: '2026-10-02' }, { Date: '2026-10-01' }];
  assert.equal(mergeBackupRows(feed, null), feed);
  assert.equal(mergeBackupRows(feed, []), feed);
});

test('loadMasjidRows: merges the feed CSV with the backup CSV', async () => {
  served['testfeed.csv'] = FEED_CSV;
  served['backup/testfeed.csv'] = BACKUP_CSV;
  const rows = await loadMasjidRows({ slug: 'testfeed', csv: 'testfeed.csv', backup_csv: 'backup/testfeed.csv' });
  assert.deepEqual(rows.map(r => r["Fajr Jama'at"]), ['06:00', '06:01', '6:30']);
  assert.equal(rows[2]._backup, true);
});

test('loadMasjidRows: no backup_csv means no backup fetch', async () => {
  served['testfeed.csv'] = FEED_CSV;
  served['backup/testfeed.csv'] = BACKUP_CSV;
  const rows = await loadMasjidRows({ slug: 'testfeed', csv: 'testfeed.csv' });
  assert.equal(rows.length, 2);
});

test('loadMasjidRows: backup alone is used when the feed CSV is missing', async () => {
  served['backup/testfeed.csv'] = BACKUP_CSV;
  const rows = await loadMasjidRows({ slug: 'testfeed', csv: 'testfeed.csv', backup_csv: 'backup/testfeed.csv' });
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r._backup));
});

test('loadMasjidRows: null when nothing loads', async () => {
  assert.equal(await loadMasjidRows({ slug: 'nope', csv: 'nope.csv', backup_csv: 'backup/nope.csv' }), null);
});
