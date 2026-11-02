import { formatValue, pm25Level } from '../lib/format.js';

const badgeClasses = {
  '#16a34a': 'bg-[#16a34a]',
  '#ca8a04': 'bg-[#ca8a04]',
  '#ea580c': 'bg-[#ea580c]',
  '#dc2626': 'bg-[#dc2626]',
  '#9333ea': 'bg-[#9333ea]',
  '#7f1d1d': 'bg-[#7f1d1d]',
};

function StatCard({ label, value, unit, digits = 1, accent, stat, badge }) {
  return (
    <div className={`rounded-xl border border-line border-t-[3px] bg-surface px-4 py-3.5 ${accent}`}>
      <div className="text-[13px] text-text-muted">{label}</div>
      <div className="mt-0.5 mb-1 text-[28px] font-semibold tabular-nums">
        {formatValue(value, digits)}
        <span className="ml-1 text-sm font-normal text-text-muted">{unit}</span>
      </div>
      <div className="min-h-5">
        {badge ? (
          <span className={`inline-block rounded-full bg-linear-to-b from-black/33 to-black/33 px-2 py-px text-xs text-white ${badgeClasses[badge.color]}`}>
            {badge.label}
          </span>
        ) : stat ? (
          <span className="text-xs text-text-muted">
            min {formatValue(stat.min, digits)} · TB {formatValue(stat.avg, digits)} · max{' '}
            {formatValue(stat.max, digits)}
          </span>
        ) : (
          <span className="text-xs text-text-muted">Không có dữ liệu</span>
        )}
      </div>
    </div>
  );
}

export default function StatCards({ latest, stats }) {
  const r = latest ?? {};
  const s = stats ?? {};
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3">
      <StatCard label="Nhiệt độ" value={r.temperature} unit="°C" accent="border-t-[#ef4444]" stat={s.temperature} />
      <StatCard label="Độ ẩm" value={r.humidity} unit="%" digits={0} accent="border-t-[#3b82f6]" stat={s.humidity} />
      <StatCard label="Ánh sáng" value={r.lux} unit="lux" accent="border-t-[#f59e0b]" stat={s.lux} />
      <StatCard
        label="PM2.5"
        value={r.pm2_5}
        unit="µg/m³"
        digits={0}
        accent="border-t-[#a855f7]"
        badge={pm25Level(r.pm2_5)}
      />
      <StatCard label="PM10" value={r.pm10} unit="µg/m³" digits={0} accent="border-t-[#64748b]" stat={s.pm10} />
    </div>
  );
}
