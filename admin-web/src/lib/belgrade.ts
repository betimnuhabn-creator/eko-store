// Kosovo / Europe/Belgrade time, independent of the phone's or PC's own time
// zone and of Intl support in the JavaScript engine (Hermes on Android).
//   CET  = UTC+1
//   CEST = UTC+2 from the last Sunday of March 01:00 UTC
//          until the last Sunday of October 01:00 UTC (EU rule).
// The database stores UTC (timestamptz); these helpers only convert for display/input.
// (Same file as admin-web/src/lib/belgrade.ts.)

const HOUR = 3600_000;

function lastSundayUtc(year: number, month: number): number {
  const d = new Date(Date.UTC(year, month + 1, 0, 1, 0)); // last day of month, 01:00 UTC
  return d.getTime() - d.getUTCDay() * 24 * HOUR;
}

/** Offset of Europe/Belgrade from UTC in minutes (60 or 120) at the given instant. */
export function belgradeOffsetMinutes(utcMs: number): number {
  const y = new Date(utcMs).getUTCFullYear();
  return utcMs >= lastSundayUtc(y, 2) && utcMs < lastSundayUtc(y, 9) ? 120 : 60;
}

export type Parts = { y: number; m: number; d: number; h: number; mi: number };

export function toBelgradeParts(iso: string | number | Date): Parts {
  const ms = new Date(iso).getTime();
  const local = new Date(ms + belgradeOffsetMinutes(ms) * 60_000);
  return { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate(), h: local.getUTCHours(), mi: local.getUTCMinutes() };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "15.11.2026 18:30" (Kosovo time) */
export function formatBelgrade(iso: string | number | Date): string {
  const p = toBelgradeParts(iso);
  return `${pad(p.d)}.${pad(p.m)}.${p.y} ${pad(p.h)}:${pad(p.mi)}`;
}

/** "2026-11-15T18:30" — value for <input type="datetime-local"> in Kosovo time. */
export function toBelgradeInput(iso: string | number | Date): string {
  const p = toBelgradeParts(iso);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

/** Kosovo wall-clock time -> UTC ISO string. */
export function fromBelgradeParts(p: Parts): string {
  const wall = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
  let utc = wall - belgradeOffsetMinutes(wall - HOUR) * 60_000;
  const check = belgradeOffsetMinutes(utc);
  if (wall - check * 60_000 !== utc) utc = wall - check * 60_000;
  return new Date(utc).toISOString();
}

/**
 * Parses "15.11.2026 18:30", "15.11.2026", "2026-11-15T18:30" or "2026-11-15 18:30"
 * as Kosovo time. Returns UTC ISO, or null if invalid.
 */
export function parseBelgrade(text: string): string | null {
  const s = text.trim();
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ ,]+(\d{1,2}):(\d{2}))?$/);
  let p: Parts | null = null;
  if (m) p = { d: +m[1], m: +m[2], y: +m[3], h: m[4] ? +m[4] : 0, mi: m[5] ? +m[5] : 0 };
  m = p ? null : s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (m) p = { y: +m[1], m: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
  if (!p) return null;
  if (p.m < 1 || p.m > 12 || p.d < 1 || p.d > 31 || p.h > 23 || p.mi > 59) return null;
  const iso = fromBelgradeParts(p);
  const back = toBelgradeParts(iso);
  // Reject impossible dates (31.02) — the round trip must give the same day.
  if (back.d !== p.d || back.m !== p.m || back.y !== p.y) return null;
  return iso;
}
