// Adapted from https://reui.io/r/base-nova/c-date-selector-1.json
// MIT Copyright (c) 2025 Keenthemes Inc. See ../../../components/reui/REUI-LICENSE.txt.
import { vi } from "date-fns/locale"
import { DateSelector } from "@/components/reui/date-selector"
import { Card, CardContent } from "@/components/ui/card"
import { fromCalendarDate, toCalendarDate } from "../lib/calendarDate.mjs"

const i18n = {
  today: "Mới nhất",
  months: Array.from({ length: 12 }, (_, i) => `Tháng ${i + 1}`),
  weekdaysShort: ["CN", "T2", "T3", "T4", "T5", "T6", "T7"],
}
const periodTypes: ["day"] = ["day"]

// Keep the registry's Card -> CardContent -> DateSelector composition.
// Date objects carry calendar dates only; API boundaries remain UTC+7.
export function DashboardDateSelector({ dates, month, first, last, available, loading, today, onSelect, onMonthChange }: {
  dates: string[]; month: string; first: string; last: string; available: string[]
  loading: boolean; today: string
  onSelect: (dates: string[]) => void; onMonthChange: (month: string) => void
}) {
  return (
    <Card className="p-0 ring-0 shadow-none">
      <CardContent className="p-0">
        <DateSelector
          selectedDates={dates.map(toCalendarDate)}
          onDatesChange={(days) => onSelect(days.map(fromCalendarDate).sort())}
          month={toCalendarDate(`${month}-01`)}
          onMonthChange={(day) => onMonthChange(fromCalendarDate(day).slice(0, 7))}
          allowRange={false} presetMode="is" periodTypes={periodTypes}
          showInput={false} showFilters={false} showPeriodTabs={false} showTwoMonths={false}
          weekStartsOn={1} i18n={i18n} dayDateFormat="dd/MM/yyyy" className="w-full sm:w-full"
          calendarProps={{
            locale: vi,
            labels: { labelDayButton: (day, modifiers) => `${day.toLocaleDateString('vi-VN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${modifiers.today ? ', hôm nay' : ''}${modifiers.selected ? ', đã chọn' : ''}` },
            today: toCalendarDate(today),
            startMonth: toCalendarDate(`${first.slice(0, 7)}-01`),
            endMonth: toCalendarDate(last),
            disabled: (day) => loading || !available.includes(fromCalendarDate(day)),
          }}
        />
      </CardContent>
    </Card>
  )
}
