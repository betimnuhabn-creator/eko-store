export const money = (n: number | null | undefined) =>
  n == null ? '' : `${Number(n).toFixed(2).replace('.', ',')} €`;

export const dateTime = (iso: string, lang: 'sq' | 'en') => {
  const d = new Date(iso);
  const pad = (x: number) => String(x).padStart(2, '0');
  const date = lang === 'sq'
    ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`
    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Parse "12,50" or "12.50" */
export const parseNumber = (s: string) => {
  const n = Number(String(s).trim().replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};
