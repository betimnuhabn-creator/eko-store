export const money = (n: number | null | undefined) =>
  n == null || Number.isNaN(Number(n)) ? '—' : `${Number(n).toFixed(2).replace('.', ',')} €`;

const pad = (x: number) => String(x).padStart(2, '0');
export const dateTime = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const dateOnly = (iso: string) => dateTime(iso).slice(0, 10);

/** "12,50" or "12.50" -> 12.5 ; invalid -> NaN */
export const parseNumber = (s: string | number) => {
  const n = Number(String(s).trim().replace(/\s/g, '').replace(',', '.'));
  return String(s).trim() === '' ? NaN : n;
};

export const normalize = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** CSV with ; separator (opens correctly in Excel with European settings). */
export function downloadCsv(filename: string, rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v ?? '');
    // Neutralise spreadsheet formulas (=, +, -, @) to avoid CSV injection.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[";\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const body = '﻿' + rows.map((r) => r.map(esc).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
