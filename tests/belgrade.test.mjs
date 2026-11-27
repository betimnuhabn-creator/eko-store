// Europe/Belgrade helper vs. the full ICU time-zone database in Node.
//   node --experimental-strip-types --test tests/belgrade.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { belgradeOffsetMinutes, formatBelgrade, fromBelgradeParts, parseBelgrade, toBelgradeInput } from '../lib/belgrade.ts';

const icu = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Belgrade', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const viaIcu = (ms) => {
  const p = Object.fromEntries(icu.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
};

test('matches ICU every 15 minutes 2024-2030 (all DST switches)', () => {
  let n = 0;
  for (let ms = Date.UTC(2024, 0, 1); ms < Date.UTC(2031, 0, 1); ms += 15 * 60_000) {
    assert.equal(formatBelgrade(ms), viaIcu(ms), new Date(ms).toISOString());
    n++;
  }
  assert.ok(n > 240_000);
});

test('wall time -> UTC round trip, including both DST days', () => {
  for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2028, 0, 1); ms += 30 * 60_000) {
    const local = toBelgradeInput(ms);
    const back = parseBelgrade(local);
    // skip the non-existent spring hour and the repeated autumn hour
    if (back === null) continue;
    if (formatBelgrade(back) === formatBelgrade(ms)) continue;
    assert.fail(`${new Date(ms).toISOString()} -> ${local} -> ${back}`);
  }
  assert.equal(parseBelgrade('15.11.2026 18:30'), '2026-11-15T17:30:00.000Z'); // CET
  assert.equal(parseBelgrade('15.07.2026 18:30'), '2026-07-15T16:30:00.000Z'); // CEST
  assert.equal(parseBelgrade('2026-11-15T18:30'), '2026-11-15T17:30:00.000Z');
  assert.equal(parseBelgrade('1.1.2027'), '2026-12-31T23:00:00.000Z');
  assert.equal(fromBelgradeParts({ y: 2026, m: 3, d: 29, h: 4, mi: 0 }), '2026-03-29T02:00:00.000Z');
  assert.equal(belgradeOffsetMinutes(Date.UTC(2026, 6, 1)), 120);
  assert.equal(belgradeOffsetMinutes(Date.UTC(2026, 0, 1)), 60);
});

test('rejects invalid input', () => {
  for (const s of ['', '31.02.2026 10:00', '15.13.2026', '2026-11-15', 'abc', '15.11.2026 25:00']) assert.equal(parseBelgrade(s), null, s);
});
