import { autoDomain, axisTicks } from '../lib/chartDomain.js';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatAxisTime, formatDateTime, formatValue } from '../lib/format.js';

const GRID = 'var(--color-chart-grid)';
const AXIS = { fontSize: 12, fill: 'var(--color-text-muted)' };

function timeAxis(from, to) {
  return (
    <XAxis
      dataKey="time"
      type="number"
      scale="time"
      domain={[from, to]}
      tickFormatter={(ms) => to - from > 86400000 ? formatDateTime(ms).slice(0, 5) : formatAxisTime(ms)}
      tick={AXIS}
      stroke="var(--color-text-muted)"
      minTickGap={40}
      allowDataOverflow
    />
  );
}

function ChartTooltip({ active, payload, label, units, formatter, labelFormatter, accessibilityLayer }) {
  if (!active || !payload?.length) return null;
  // Match Recharts' default name sorting; the legend keeps declaration order instead.
  const items = [...payload].sort((a, b) => a.name > b.name ? 1 : a.name < b.name ? -1 : 0);
  return (
    <div className="m-0 whitespace-nowrap rounded-lg border border-input-line bg-surface p-2.5 text-[13px] text-text"
      role={accessibilityLayer ? 'status' : undefined}
      aria-live={accessibilityLayer ? 'assertive' : undefined}>
      <p className="m-0">{labelFormatter ? labelFormatter(label, payload) : formatDateTime(label)}</p>
      <ul className="m-0 list-none p-0">
        {items.map((item, index) => {
          if (!item || item.type === 'none') return null;
          const [value, name] = formatter
            ? formatter(item.value, item.name, item)
            : [`${formatValue(item.value)} ${units[item.dataKey] ?? ''}`, item.name];
          return (
            <li className="block py-1" key={`${item.dataKey ?? item.name}-${index}`}>
              <span>{name}</span><span> : </span><span>{value}</span><span>{item.unit ?? ''}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ChartLegend({ payload }) {
  if (!payload?.length) return null;
  return (
    <ul className="m-0 list-none p-0 text-center text-text">
      {payload.map((item, index) => {
        if (!item || item.type === 'none') return null;
        const color = item.inactive ? '#ccc' : item.color;
        return (
          <li className="mr-2.5 inline-block whitespace-nowrap" key={`${item.dataKey ?? item.value}-${index}`}>
            <svg className="mr-1 inline-block size-3.5 align-middle" viewBox="0 0 32 32" aria-hidden="true">
              {item.type === 'plainline' ? (
                <line x1="0" y1="16" x2="32" y2="16" stroke={color} strokeWidth={4} />
              ) : (
                <path d="M0,16h10.6667 A5.3333,5.3333,0,1,1,21.3333,16 H32 M21.3333,16 A5.3333,5.3333,0,1,1,10.6667,16" fill="none" stroke={color} strokeWidth={4} />
              )}
            </svg>
            <span>{item.value}</span>
          </li>
        );
      })}
    </ul>
  );
}

function tooltip(units) {
  return (
    <Tooltip
      labelFormatter={(t) => formatDateTime(t)}
      formatter={(value, name, item) => [
        `${formatValue(value)} ${units[item.dataKey] ?? ''}`,
        name,
      ]}
      content={<ChartTooltip units={units} />}
      cursor={{ stroke: 'var(--color-text-muted)' }}
    />
  );
}

function ChartCard({ title, subtitle, children, empty }) {
  return (
    <section className="min-w-0 rounded-xl border border-line bg-surface px-4 py-3.5">
      <header className="mb-2 flex flex-wrap items-baseline gap-2">
        <h2 className="text-[16px] font-bold">{title}</h2>
        {subtitle && <span className="text-[13px] text-text-muted">{subtitle}</span>}
      </header>
      <div className="h-[280px]">
        {empty ? (
          <div className="grid h-full place-items-center rounded-lg border border-dashed border-line text-[14px] text-text-muted">
            Không có dữ liệu trong khoảng này
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {children}
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}

const hasAny = (points, keys) =>
  points.some((p) => keys.some((k) => p[k] !== null));

export function ClimateChart({ points, from, to }) {
  const domains = {
    temperature: autoDomain(points, 'temperature'),
    humidity: autoDomain(points, 'humidity'),
  };
  const empty = !hasAny(points, ['temperature', 'humidity']);

  return (
    <ChartCard title="Nhiệt độ & Độ ẩm" subtitle="DHT11" empty={empty}>
      <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
        {timeAxis(from, to)}
        <YAxis
          yAxisId="t"
          tick={AXIS}
          stroke="var(--color-text-muted)"
          domain={domains.temperature}
          ticks={axisTicks(domains.temperature)}
          allowDataOverflow
          tickFormatter={(v) => `${formatValue(v)}°`}
        />
        <YAxis
          yAxisId="h"
          orientation="right"
          tick={AXIS}
          stroke="var(--color-text-muted)"
          domain={domains.humidity}
          ticks={axisTicks(domains.humidity)}
          allowDataOverflow
          tickFormatter={(v) => `${formatValue(v)}%`}
        />
        {tooltip({ temperature: '°C', humidity: '%' })}
        <Legend content={<ChartLegend />} itemSorter={null} />
        <Line type="monotoneX" connectNulls={false} yAxisId="t" dataKey="temperature" name="Nhiệt độ" stroke="var(--color-chart-red)" strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line type="monotoneX" connectNulls={false} yAxisId="h" dataKey="humidity" name="Độ ẩm" stroke="var(--color-chart-blue)" strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ChartCard>
  );
}

export function LightChart({ points, from, to }) {
  return (
    <ChartCard title="Cường độ ánh sáng" subtitle="BH1750 · lux" empty={!hasAny(points, ['lux'])}>
      <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
        <defs>
          <linearGradient id="luxFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-chart-amber)" stopOpacity={0.45} />
            <stop offset="100%" stopColor="var(--color-chart-amber)" stopOpacity={0.03} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
        {timeAxis(from, to)}
        <YAxis tick={AXIS} stroke="var(--color-text-muted)" domain={[0, 'auto']} />
        {tooltip({ lux: 'lux' })}
        <Area type="monotoneX" connectNulls={false} dataKey="lux" name="Ánh sáng" stroke="var(--color-chart-amber)" strokeWidth={2} fill="url(#luxFill)" isAnimationActive={false} />
      </AreaChart>
    </ChartCard>
  );
}

export function DustChart({ points, from, to }) {
  return (
    <ChartCard title="Bụi mịn" subtitle="PMS7003 · µg/m³" empty={!hasAny(points, ['pm1_0', 'pm2_5', 'pm10'])}>
      <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
        {timeAxis(from, to)}
        <YAxis tick={AXIS} stroke="var(--color-text-muted)" domain={[0, 'auto']} />
        {tooltip({ pm1_0: 'µg/m³', pm2_5: 'µg/m³', pm10: 'µg/m³' })}
        <Legend content={<ChartLegend />} itemSorter={null} />
        <ReferenceLine y={35.4} stroke="var(--color-chart-orange)" strokeDasharray="4 4" label={{ value: 'Ngưỡng PM2.5 kém: 35,4', position: 'insideTopLeft', fontSize: 11, fill: 'var(--color-chart-orange)' }} />
        <Line type="monotoneX" connectNulls={false} dataKey="pm1_0" name="PM1.0" stroke="var(--color-chart-green)" strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line type="monotoneX" connectNulls={false} dataKey="pm2_5" name="PM2.5" stroke="var(--color-chart-purple)" strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line type="monotoneX" connectNulls={false} dataKey="pm10" name="PM10" stroke="var(--color-chart-slate)" strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ChartCard>
  );
}

export function SignalChart({ points, from, to }) {
  return (
    <ChartCard title="Tín hiệu WiFi" subtitle="RSSI · dBm" empty={!hasAny(points, ['rssi'])}>
      <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
        {timeAxis(from, to)}
        <YAxis tick={AXIS} stroke="var(--color-text-muted)" domain={['auto', 'auto']} allowDecimals={false} />
        {tooltip({ rssi: 'dBm' })}
        <Line type="monotoneX" connectNulls={false} dataKey="rssi" name="RSSI" stroke="var(--color-chart-sky)" strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ChartCard>
  );
}
