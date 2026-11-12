import { addDays, DAY_MS, MAX_SELECTED_DAYS, parseDate, selectedDates, shiftMonth, shortDate, todayVN } from '../../../../../shared/time.mjs';

export const RECENT_RANGES = { '15m': '15 phút', '1h': '1 giờ', '6h': '6 giờ', '24h': '24 giờ' };

// Work with day keys, never elapsed local milliseconds (DST/browser timezone).
export function datesInRange(from, to, today = todayVN()) {
  const start = parseDate(from);
  const end = parseDate(to);
  if (start === null || end === null || end < start) throw new Error('Chọn ngày kết thúc không trước ngày bắt đầu.');
  const count = (end - start) / DAY_MS + 1;
  if (count > MAX_SELECTED_DAYS) throw new Error(`Tối đa ${MAX_SELECTED_DAYS} ngày mỗi lần.`);
  return selectedDates(Array.from({ length: count }, (_, i) => addDays(from, i)), today);
}

export function isContinuous(dates) {
  return dates.length > 0 && dates.every((day, i) => i === 0 || day === addDays(dates[i - 1], 1));
}

export function historicalPresets(today = todayVN()) {
  const month = today.slice(0, 7);
  return [
    { label: 'Hôm nay', from: today, to: today },
    { label: '7 ngày gần đây', from: addDays(today, -6), to: today },
    { label: '30 ngày gần đây', from: addDays(today, -29), to: today },
    { label: 'Tháng này', from: `${month}-01`, to: today },
    { label: 'Tháng trước', from: `${shiftMonth(month, -1)}-01`, to: addDays(`${month}-01`, -1) },
  ].map((preset) => ({ ...preset, dates: datesInRange(preset.from, preset.to, today) }));
}

export function periodLabel(value) {
  if (value.mode === 'recent') return `${RECENT_RANGES[value.range]} gần đây`;
  const dates = value.dates;
  if (!dates.length) return 'Chọn ngày';
  if (dates.length === 1) return shortDate(dates[0]);
  return isContinuous(dates) ? `${shortDate(dates[0])} – ${shortDate(dates.at(-1))}` : `${dates.length} ngày đã chọn`;
}

// Only the current keyed availability result may validate a draft selection.
export function validatedDraft(dates, data) {
  if (!dates.length || dates.length > MAX_SELECTED_DAYS || !data) return { dates: [], skipped: [] };
  const valid = new Set(data.validDates);
  return { dates: dates.filter((day) => valid.has(day)), skipped: dates.filter((day) => !valid.has(day)) };
}
