import { addDays, weekStart, selectedDates, todayVN, RANGE_MS } from '../../../../shared/time.mjs';

export const FILTERS_KEY = 'nhom13.filters';

export function validatePeriod(value, today = todayVN()) {
  const fallback = { mode: 'recent', range: '1h' };
  try {
    if (value?.mode === 'recent' && typeof value.range === 'string' && Object.hasOwn(RANGE_MS, value.range)) {
      return { mode: 'recent', range: value.range };
    }
    if (value?.mode === 'dates' && Array.isArray(value.dates)) {
      return { mode: 'dates', dates: value.dates.length ? selectedDates(value.dates, today) : [] };
    }
    if (value?.mode === 'day' || value?.mode === 'week') {
      selectedDates([value.date], today);
      const dates = value.mode === 'week'
        ? Array.from({ length: 7 }, (_, i) => addDays(weekStart(value.date), i)).filter((day) => day <= today)
        : [value.date];
      return { mode: 'dates', dates };
    }
  } catch { /* Invalid stored data is not a request. */ }
  // Invalid preferences fall back to live recent data, without a DB scan.
  return fallback;
}

export function validateDevice(value) {
  return typeof value === 'string' && value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) ? value : '';
}

// Access localStorage inside try: even its getter may throw in private/blocked contexts.
export function readFilters(storage, today = todayVN()) {
  let value;
  try { value = JSON.parse((storage ?? window.localStorage).getItem(FILTERS_KEY)); } catch { /* Use defaults. */ }
  return { period: validatePeriod(value?.period, today), device: validateDevice(value?.device) };
}

export function saveFilters(period, device, storage) {
  try {
    (storage ?? window.localStorage).setItem(FILTERS_KEY, JSON.stringify({ period: validatePeriod(period), device: validateDevice(device) }));
  } catch { /* Filtering still works when storage is unavailable/full. */ }
}

