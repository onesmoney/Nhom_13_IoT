import { formatDateTime, formatValue } from '../lib/format.js';
import { readingResolution } from '../lib/readingResolution.mjs';

const COLUMNS = [
  ['temperature', 'Nhiệt độ (°C)', 1],
  ['humidity', 'Độ ẩm (%)', 0],
  ['lux', 'Ánh sáng (lux)', 1],
  ['pm1_0', 'PM1.0', 0],
  ['pm2_5', 'PM2.5', 0],
  ['pm10', 'PM10', 0],
];
const cell = 'border-b border-page-bg px-2.5 py-[7px] text-right whitespace-nowrap first:text-left';
const heading = `${cell} text-[13px] font-medium text-text-muted`;

export default function RecentTable({ rows }) {
  return (
    <section className="min-w-0 rounded-xl border border-line bg-surface px-4 py-3.5">
      <header className="mb-2 flex flex-wrap items-baseline gap-2">
        <h2 className="text-base font-bold">Bản ghi gần nhất</h2>
        <span className="text-[13px] text-text-muted">trong khoảng đã chọn · UTC+7</span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm tabular-nums">
          <thead>
            <tr>
              <th className={heading}>Thời gian</th>
              <th className={heading}>Loại dữ liệu</th>
              {COLUMNS.map(([key, label]) => (
                <th className={heading} key={key}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className={cell}>{formatDateTime(r.time)}</td>
                <td className={cell} title={r.aggregation
                  ? `${formatDateTime(r.aggregation.bucketStart)} đến trước ${formatDateTime(r.aggregation.bucketEnd)}; số mẫu hợp lệ có thể khác nhau giữa các cảm biến.`
                  : 'Số đo gốc, chưa được gộp.'}>
                  {readingResolution(r)}
                </td>
                {COLUMNS.map(([key, , digits]) => (
                  <td className={cell} key={key}>{formatValue(r[key], digits)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
