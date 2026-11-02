export const DAY_MS = 86400000;
export const VN_OFFSET_MS = 7 * 3600000;
// Explicit request budget: days need individual indexed reads, not a continuous range.
export const MAX_SELECTED_DAYS = 31;
export function selectedDates(value, today = todayVN()) {
  const dates = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(dates) || !dates.length || dates.length > MAX_SELECTED_DAYS ||
      dates.some((date) => parseDate(date) === null || date < '1970-01-01' || date > today)) {
    throw new Error(`Chọn từ 1 đến ${MAX_SELECTED_DAYS} ngày hợp lệ, không ở tương lai`);
  }
  return [...new Set(dates)].sort();
}
export const RANGE_MS = { '15m': 900000, '1h': 3600000, '6h': 21600000, '24h': 86400000 };

// Calendar arithmetic uses UTC dates; actual day boundaries are UTC+7.
export function parseDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date ? ms : null;
}
export function addDays(date, days) {
  return new Date(parseDate(date) + days * DAY_MS).toISOString().slice(0, 10);
}
export function todayVN(now = Date.now()) {
  return new Date(now + VN_OFFSET_MS).toISOString().slice(0, 10);
}
export function weekStart(date) {
  const weekday = new Date(parseDate(date)).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}
export function calendarBounds(date, mode = 'day') {
  const start = mode === 'week' ? weekStart(date) : date;
  const from = parseDate(start) - VN_OFFSET_MS;
  return { from, to: from + (mode === 'week' ? 7 : 1) * DAY_MS - 1 };
}
export function monthDays(month) {
  const start = weekStart(`${month}-01`);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}
export function shiftMonth(month, delta) {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
}
export function shortDate(date) {
  return date.split('-').reverse().join('/');
}
