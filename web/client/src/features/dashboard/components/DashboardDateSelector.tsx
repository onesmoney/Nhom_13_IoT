import { DatePicker, type DateRange } from '@cloudflare/kumo';
import { vi } from 'date-fns/locale';
import { fromCalendarDate, toCalendarDate } from '../lib/calendarDate.mjs';

type Props = {
  dates: string[]; range: DateRange | undefined; selection: 'range' | 'multiple';
  month: string; first: string; last: string;
  today: string; numberOfMonths: number;
  onSelect: (dates: string[]) => void; onRangeChange: (range: DateRange | undefined) => void;
  onMonthChange: (month: string) => void;
};

// Dates carry calendar components only; API day boundaries remain UTC+7.
export function DashboardDateSelector({ dates, range, selection, month, first, last,
  today, numberOfMonths, onSelect, onRangeChange, onMonthChange }: Props) {
  const common = {
    month: toCalendarDate(`${month}-01`),
    onMonthChange: (day: Date) => onMonthChange(fromCalendarDate(day).slice(0, 7)),
    numberOfMonths,
    locale: vi,
    weekStartsOn: 1 as const,
    today: toCalendarDate(today),
    startMonth: toCalendarDate(`${first.slice(0, 7)}-01`),
    endMonth: toCalendarDate(last),
    animate: false,
    labels: {
      labelPrevious: () => 'Tháng trước',
      labelNext: () => 'Tháng sau',
      labelDayButton: (day: Date, modifiers: { today?: boolean; selected?: boolean }) =>
        `${day.toLocaleDateString('vi-VN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${modifiers.today ? ', hôm nay' : ''}${modifiers.selected ? ', đã chọn' : ''}`,
    },
    disabled: (day: Date) => {
      const key = fromCalendarDate(day);
      return key < first || key > last || key > today;
    },
  };
  return selection === 'range'
    ? <DatePicker {...common} mode="range" selected={range} onChange={onRangeChange} />
    : <DatePicker {...common} mode="multiple" selected={dates.map(toCalendarDate)}
        onChange={(days) => onSelect((days ?? []).map(fromCalendarDate).sort())} />;
}
