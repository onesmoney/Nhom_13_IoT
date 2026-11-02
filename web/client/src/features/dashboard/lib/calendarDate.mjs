// react-day-picker uses local calendar dates, not UTC timestamps.
// Do not use toISOString(): users outside UTC+7 must select the same date key.
export function toCalendarDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day, 12);
}

export function fromCalendarDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
