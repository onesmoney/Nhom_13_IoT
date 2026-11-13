import { useEffect, useId, useState } from 'react';
import { Popover, Button } from '@cloudflare/kumo';
import { CalendarDotsIcon, CaretDownIcon } from '@phosphor-icons/react';
import { DashboardDateSelector } from './DashboardDateSelector';
import { MAX_SELECTED_DAYS, shortDate, todayVN } from '../../../../../shared/time.mjs';
import { useAvailability } from '../hooks/useAvailability.js';
import { fromCalendarDate, toCalendarDate } from '../lib/calendarDate.mjs';
import { datesInRange, historicalPresets, isContinuous, periodLabel, RECENT_RANGES, validatedDraft } from '../lib/datePresets.mjs';

export { periodLabel } from '../lib/datePresets.mjs';

function CalendarSelection({ value, device, onApply, onCancel }) {
  const [dates, setDates] = useState(value.dates ?? []);
  const [mode, setMode] = useState(value.mode);
  const [recentRange, setRecentRange] = useState(value.range ?? '1h');
  const [selection, setSelection] = useState(value.dates?.length && !isContinuous(value.dates) ? 'multiple' : 'range');
  const [dateRange, setDateRange] = useState(() => value.dates?.length && isContinuous(value.dates)
    ? { from: toCalendarDate(value.dates[0]), to: toCalendarDate(value.dates.at(-1)) } : undefined);
  const [month, setMonth] = useState(() => (value.dates?.[0] || todayVN()).slice(0, 7));
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 960px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 960px)');
    const update = () => setWide(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const availability = useAvailability(device);
  const data = availability.data;
  const bounds = data;
  const today = todayVN();
  const { dates: validDates, skipped } = validatedDraft(dates, data);
  const [message, setMessage] = useState('');
  const complete = selection === 'multiple' || !!dateRange?.to;
  const canApply = mode === 'recent' || (complete && !message && validDates.length > 0 && !availability.loading && !availability.error);
  useEffect(() => {
    if (!bounds?.first) return;
    if (month < bounds.first.slice(0, 7)) setMonth(bounds.first.slice(0, 7));
    else if (month > bounds.last.slice(0, 7)) setMonth(bounds.last.slice(0, 7));
  }, [bounds, month]);

  function selectRange(next) {
    setMode('dates');
    setDateRange(next);
    setMessage('');
    try {
      setDates(next?.from && next?.to ? datesInRange(fromCalendarDate(next.from), fromCalendarDate(next.to), today) : []);
    } catch (err) { setDates([]); setMessage(err.message); }
  }

  function selectPreset(preset) {
    setMode('dates');
    setSelection('range');
    setDates(preset.dates);
    setDateRange({ from: toCalendarDate(preset.from), to: toCalendarDate(preset.to) });
    setMonth(preset.from.slice(0, 7));
    setMessage('');
  }

  function switchSelection(next) {
    setSelection(next);
    setMessage('');
    if (next === 'range') {
      const continuous = isContinuous(dates);
      setDateRange(continuous ? { from: toCalendarDate(dates[0]), to: toCalendarDate(dates.at(-1)) } : undefined);
      if (!continuous) setDates([]);
    }
  }

  return <>
    <div className="flex flex-col min-[600px]:flex-row">
      <div className="flex shrink-0 flex-col gap-1 border-b border-kumo-line p-3 min-[600px]:w-48 min-[600px]:border-r min-[600px]:border-b-0" aria-label="Khoảng thời gian có sẵn">
        <span className="px-2 py-1 text-xs font-medium text-kumo-subtle">Thời gian thực</span>
        <div className="grid grid-cols-2 gap-1 min-[600px]:grid-cols-1">
          {Object.entries(RECENT_RANGES).map(([key, label]) => <button key={key} type="button"
            aria-pressed={mode === 'recent' && recentRange === key}
            onClick={() => { setMode('recent'); setRecentRange(key); setMessage(''); }}
            className={`time-preset ${mode === 'recent' && recentRange === key ? 'bg-kumo-contrast text-kumo-inverse' : 'text-kumo-default hover:bg-kumo-tint'}`}>{label} gần đây</button>)}
        </div>
        <span className="px-2 pt-3 pb-1 text-xs font-medium text-kumo-subtle">Theo ngày · UTC+7</span>
        <div className="grid grid-cols-2 gap-1 min-[600px]:grid-cols-1">
          {historicalPresets(today).map((preset) => <button key={preset.label} type="button"
            aria-pressed={mode === 'dates' && dates.join(',') === preset.dates.join(',')}
            onClick={() => selectPreset(preset)}
            className={`time-preset ${mode === 'dates' && dates.join(',') === preset.dates.join(',') ? 'bg-kumo-contrast text-kumo-inverse' : 'text-kumo-default hover:bg-kumo-tint'}`}>{preset.label}</button>)}
        </div>
      </div>
      <div className="min-w-0 flex-1 p-3">
        <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Cách chọn ngày">
          <Button variant={selection === 'range' ? 'primary' : 'outline'} aria-pressed={selection === 'range'} onClick={() => switchSelection('range')}>Khoảng ngày</Button>
          <Button variant={selection === 'multiple' ? 'primary' : 'outline'} aria-pressed={selection === 'multiple'} onClick={() => switchSelection('multiple')}>Từng ngày</Button>
        </div>
        <p className="mb-3 text-sm text-kumo-subtle">{selection === 'range' ? 'Chọn ngày bắt đầu và ngày kết thúc.' : 'Chọn các ngày muốn xem, không cần liền nhau.'}</p>
        {bounds?.first ? <DashboardDateSelector dates={mode === 'dates' ? dates : []} range={mode === 'dates' ? dateRange : undefined}
          selection={selection} month={month} first={bounds.first} last={bounds.last}
          numberOfMonths={wide && selection === 'range' ? 2 : 1}
          today={today} onMonthChange={setMonth} onRangeChange={selectRange} onSelect={(next) => {
            if (next.length > MAX_SELECTED_DAYS) { setMessage(`Tối đa ${MAX_SELECTED_DAYS} ngày mỗi lần.`); return; }
            setMessage(''); setMode('dates'); setDates(next);
          }} /> : <p className="py-8 text-sm text-kumo-subtle">{availability.loading ? 'Đang tải lịch…' : 'Chưa có ngày để hiển thị.'}</p>}
        <div className="mt-3 text-sm text-kumo-subtle" aria-live="polite">
          {!device ? 'Chưa có thiết bị' : availability.loading ? 'Đang tìm ngày có dữ liệu cũ nhất…'
            : availability.error ? <span role="alert">{availability.error} <Button variant="ghost" onClick={availability.reload}>Thử lại</Button></span>
            : !data?.first ? 'Thiết bị chưa có dữ liệu.' : mode === 'dates' ? `${validDates.length} ngày đã chọn. Ngày không có dữ liệu sẽ để trống.` : 'Khoảng giờ gần đây tiếp tục cập nhật tự động.'}
          {data?.first && <p>Có thể chọn từ {shortDate(data.first)} đến hôm nay.</p>}
          {mode === 'dates' && !complete && <p>Chọn thêm ngày kết thúc để áp dụng.</p>}
          {mode === 'dates' && skipped.length > 0 && <p>{skipped.length} ngày nằm ngoài khoảng cho phép: {skipped.map(shortDate).join(', ')}.</p>}
          {message && <p role="alert" className="text-error-text">{message}</p>}
        </div>
        {mode === 'dates' && selection === 'multiple' && dates.length > 0 && <div className="mt-3 flex max-h-24 flex-wrap gap-1 overflow-auto" aria-label="Ngày đã chọn">
          {dates.map((day) => <Button key={day} size="sm" variant="secondary" aria-label={`Bỏ ${shortDate(day)}`}
            onClick={() => { setDates(dates.filter((d) => d !== day)); setMessage(''); }}>{shortDate(day)} ×</Button>)}
        </div>}
      </div>
    </div>
    <div className="flex flex-wrap items-center justify-end gap-3 border-t border-kumo-line p-3">
      <div className="flex gap-2">
        <Button variant="outline" onClick={onCancel}>Hủy</Button>
        <Button variant="primary" disabled={!canApply} onClick={() => onApply(mode === 'recent'
          ? { mode: 'recent', range: recentRange } : { mode: 'dates', dates: validDates })}>Áp dụng</Button>
      </div>
    </div>
  </>;
}

export default function TimePicker({ value, device, onChange }) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  return <Popover open={open} onOpenChange={setOpen}>
    <Popover.Trigger render={<Button variant="outline" className="h-10 min-h-10 min-w-0 max-w-full rounded-lg whitespace-nowrap text-left text-sm leading-5 max-[600px]:w-full" />}>
      <CalendarDotsIcon aria-hidden="true" size={18} className="shrink-0" /><span className="truncate">{periodLabel(value)}</span><CaretDownIcon aria-hidden="true" size={16} className="shrink-0" />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner sideOffset={8} align="end" collisionPadding={12} className="z-30">
        <Popover.Popup aria-labelledby={titleId} className="sensor-time-picker max-h-[min(var(--available-height,100dvh),calc(100dvh_-_24px))] w-max max-w-[calc(100vw_-_24px)] overflow-y-auto overscroll-contain p-0">
          <Popover.Title id={titleId} className="border-b border-kumo-line px-4 py-3 text-sm font-semibold">Chọn thời gian cảm biến</Popover.Title>
          {open && <CalendarSelection key={device} value={value} device={device}
            onCancel={() => setOpen(false)} onApply={(next) => { onChange(next); setOpen(false); }} />}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover>;
}
