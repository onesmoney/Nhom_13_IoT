import { useEffect, useId, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { CalendarDays, ChevronDown } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { DashboardDateSelector } from './DashboardDateSelector';
import { MAX_SELECTED_DAYS, shortDate, todayVN } from '../../../../../shared/time.mjs';
import { useAvailability } from '../hooks/useAvailability.js';

const RECENT_RANGES = { '15m': '15 phút', '1h': '1 giờ', '6h': '6 giờ', '24h': '24 giờ' };

export function periodLabel(value) {
  if (value.mode === 'recent') return `${RECENT_RANGES[value.range]} gần đây`;
  if (!value.dates.length) return 'Chọn ngày';
  return value.dates.length === 1 ? shortDate(value.dates[0]) : `${value.dates.length} ngày đã chọn`;
}

function CalendarSelection({ value, device, extent, onApply, onCancel }) {
  const [dates, setDates] = useState(value.dates ?? []);
  const [mode, setMode] = useState(value.mode);
  const [range, setRange] = useState(value.range ?? '1h');
  const [month, setMonth] = useState(() => (value.dates?.at(-1) || extent?.last || todayVN()).slice(0, 7));
  const availability = useAvailability(device, month, dates);
  const data = availability.data;
  const calendar = availability.calendar;
  const bounds = calendar || extent;
  useEffect(() => {
    if (!bounds?.first) return;
    if (month < bounds.first.slice(0, 7)) setMonth(bounds.first.slice(0, 7));
    else if (month > bounds.last.slice(0, 7)) setMonth(bounds.last.slice(0, 7));
  }, [bounds, month]);
  const valid = dates.length > 0 && dates.length <= MAX_SELECTED_DAYS && data?.validDates.length === dates.length;
  const [limitMessage, setLimitMessage] = useState('');
  return <>
    <div className="grid grid-cols-2 gap-2" role="group" aria-label="Khoảng giờ gần đây">
      {Object.entries(RECENT_RANGES).map(([key, label]) => <Button key={key}
        variant={mode === 'recent' && range === key ? 'default' : 'outline'}
        aria-pressed={mode === 'recent' && range === key}
        onClick={() => { setMode('recent'); setRange(key); setDates([]); }}>{label} gần đây</Button>)}
    </div>
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm">Chọn từng ngày có dữ liệu</span>
      <span className="text-xs text-muted-foreground">UTC+7</span>
    </div>
    {bounds?.first && <DashboardDateSelector dates={dates} month={month} first={bounds.first} last={bounds.last}
      available={calendar?.days || []} loading={!calendar}
      today={todayVN()} onMonthChange={setMonth} onSelect={(next) => {
        if (next.length > MAX_SELECTED_DAYS) { setLimitMessage(`Tối đa ${MAX_SELECTED_DAYS} ngày mỗi lần.`); return; }
        setLimitMessage(''); setMode('dates'); setDates(next);
      }} />}
    <div className="text-center text-sm text-muted-foreground" aria-live="polite">
      {!device ? 'Chưa có thiết bị' : availability.loading ? 'Đang kiểm tra ngày có dữ liệu…'
        : availability.error ? <span role="alert">{availability.error} <Button variant="ghost" onClick={availability.reload}>Thử lại</Button></span>
        : !data?.first ? 'Thiết bị chưa có dữ liệu.' : !data.days.length ? 'Tháng này không có dữ liệu.' : `${dates.length} ngày đã chọn`}
      {data && dates.some((day) => !data.validDates.includes(day)) && <div>Ngày không còn dữ liệu. <Button variant="ghost" onClick={() => setDates(data.validDates)}>Bỏ ngày không hợp lệ</Button></div>}
      {limitMessage && <div role="alert">{limitMessage}</div>}
    </div>
    {dates.length > 0 && <div className="flex flex-wrap gap-1 max-h-24 overflow-auto" aria-label="Ngày đã chọn">
      {dates.map((day) => <Button key={day} size="sm" variant="secondary" aria-label={`Bỏ ${shortDate(day)}`} onClick={() => setDates(dates.filter((d) => d !== day))}>{shortDate(day)} ×</Button>)}
    </div>}
    <div className="text-xs text-muted-foreground">Tối đa {MAX_SELECTED_DAYS} ngày/lần; truy vấn tối đa 100.000 bản ghi.</div>
    <div className="flex justify-end gap-2 border-t border-border pt-3">
      <Button variant="outline" onClick={onCancel}>Hủy</Button>
      <Button disabled={mode === 'dates' && (!valid || availability.loading || !!availability.error)}
        onClick={() => onApply(mode === 'recent' ? { mode: 'recent', range } : { mode: 'dates', dates })}>Áp dụng</Button>
    </div>
  </>;
}

export default function TimePicker({ value, device, extent, onChange }) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <div className="font-sans text-sm leading-[1.4] text-foreground">
        <Popover.Trigger render={<Button variant="outline" className="[@media(max-width:600px)]:h-auto [@media(max-width:600px)]:min-h-9 [@media(max-width:600px)]:w-full [@media(max-width:600px)]:whitespace-normal" />}>
          <CalendarDays aria-hidden="true" />{periodLabel(value)}<ChevronDown aria-hidden="true" />
        </Popover.Trigger>
      </div>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="end" collisionPadding={12} className="z-30 font-sans text-sm leading-[1.4] text-foreground">
          <Popover.Popup className="flex max-h-[min(var(--available-height,100dvh),calc(100dvh_-_24px))] w-[min(340px,calc(100vw_-_24px),var(--available-width,100vw))] flex-col gap-3 overflow-y-auto overscroll-contain rounded-xl border border-border bg-background p-4 shadow-[0_8px_28px_rgb(15_23_42_/_0.15)] *:min-w-0 *:shrink-0" aria-labelledby={titleId}>
            <Popover.Title id={titleId} className="text-sm font-semibold">Chọn thời gian</Popover.Title>
            {open && <CalendarSelection key={device} value={value} device={device} extent={extent}
              onCancel={() => setOpen(false)} onApply={(next) => { onChange(next); setOpen(false); }} />}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
