import { Moon, RefreshCw, Sun } from 'lucide-react';
import { ClimateChart, DustChart, LightChart } from './components/Charts.jsx';
import StatCards from './components/StatCards.jsx';
import { ConnectionState, DeviceState, statusPill } from './components/StatusBar.jsx';
import TimePicker from './components/TimePicker.jsx';
import { useDashboard } from './hooks/useDashboard.js';

const muted = 'text-[13px] text-[#5b6575] dark:text-[#b6c2d2]';
const control = 'inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#9ca3af] bg-white px-2.5 py-1.5 text-[13px] text-[#111827] hover:bg-[#f3f4f6] focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[#2563eb] dark:border-[#64748b] dark:bg-[#1e293b] dark:text-[#f1f5f9] dark:hover:bg-[#0f172a] dark:focus-visible:outline-[#93c5fd]';
const errorAlert = 'rounded-lg border border-[#fecaca] bg-[#fef2f2] px-3.5 py-2.5 text-sm text-[#991b1b] dark:border-[#9f4b5e] dark:bg-[#3f202c] dark:text-[#fecaca]';
const infoAlert = 'rounded-lg border border-[#bfdbfe] bg-[#eff6ff] px-3.5 py-2.5 text-sm text-[#1e40af] dark:border-[#476eab] dark:bg-[#172f50] dark:text-[#bfdbfe]';

export default function DashboardPage() {
  const {
    period, setPeriod, selected, setSelected, theme, toggleTheme,
    devices, device, data, error, loading, chartsLoading, refreshing, reload,
    status, connected, cachedDataNotice, points, from, to, statReading, liveLatest,
  } = useDashboard();
  const refreshBusy = chartsLoading || refreshing;

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-6 pt-5 pb-10 max-[600px]:px-3 max-[600px]:pt-4 max-[600px]:pb-7">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold max-[600px]:text-xl">Giám sát môi trường · Nhóm 13</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ConnectionState connected={connected} status={status} />
          <DeviceState latest={liveLatest} stale={Boolean(status?.cache?.available && status.cache.stale)} />
          <button type="button" className={`${statusPill} w-[84px] shrink-0 cursor-pointer justify-center whitespace-nowrap text-text hover:bg-page-bg focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-focus`} aria-label="Chế độ tối" aria-pressed={theme === 'dark'}
            onClick={toggleTheme}>
            {theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
            {theme === 'dark' ? 'Sáng' : 'Tối'}
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-w-0 max-w-full items-center gap-2 text-sm max-[600px]:flex-1">
          Thiết bị
          <select
            className="h-10 min-w-0 max-w-full rounded-lg border border-[#9ca3af] bg-white px-2.5 py-0 text-inherit leading-5 focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[#2563eb] disabled:cursor-default max-[600px]:flex-1 dark:border-[#64748b] dark:bg-[#1e293b] dark:focus-visible:outline-[#93c5fd]"
            value={device}
            onChange={(e) => setSelected(e.target.value)}
            disabled={devices.length === 0 && !selected}
          >
            {!device && <option value="">Chưa có thiết bị</option>}
            {/* An offline device may still have historical readings. Keep its saved selection. */}
            {selected && !devices.some((d) => d.device === selected) && <option value={selected}>{selected}</option>}
            {devices.map((d) => (
              <option key={d.device} value={d.device}>
                {d.device}
                {d.location ? ` — ${d.location}` : ''}
              </option>
            ))}
          </select>
        </label>
        <span className={muted} role="status">{chartsLoading ? 'Đang tải…' : ''}</span>
        <div className="ml-auto flex min-w-0 max-w-full items-center gap-3 max-[600px]:ml-0 max-[600px]:w-full">
          <div className="min-w-0 max-[600px]:flex-1"><TimePicker value={period} device={device} onChange={setPeriod} /></div>
          <button type="button"
            className={`${control} size-10 shrink-0 justify-center disabled:cursor-wait disabled:opacity-60`}
            aria-label="Tải lại dữ liệu" title="Tải lại dữ liệu" aria-busy={refreshBusy}
            disabled={refreshBusy || !device} onClick={reload}>
            <RefreshCw size={18} aria-hidden="true" className={refreshBusy ? 'motion-safe:animate-spin' : undefined} />
          </button>
        </div>
      </div>

      {status?.firebase === 'error' && (
        <div className={errorAlert}>
          <strong>Không đọc được Firebase:</strong> {status.error}
        </div>
      )}
      {period.mode === 'dates' && data && !loading && !error && data.count === 0 && <div className={infoAlert}>Không có dữ liệu trong các ngày đã chọn.</div>}
      {error && (
        <div className={errorAlert} role="alert">
          <strong>Không tải được dữ liệu:</strong> {error} <button type="button" className={control} onClick={reload}>Thử lại</button>
        </div>
      )}
      {!loading && connected && status?.firebase === 'online' && devices.length === 0 && (
        <div className={infoAlert}>
          Chưa có dữ liệu trong /{status.dataPath} ở {status.historyHours} giờ qua. Hãy bật ESP32 để gửi dữ liệu.
        </div>
      )}

      {cachedDataNotice && <div className={infoAlert} role="status">{cachedDataNotice}</div>}

      <StatCards mode={period.mode} latest={statReading} stats={data?.stats} />

      {data?.partialBucketCoverage && (
        <p className={muted}>
          Khoảng chọn cắt giữa một nhóm 5 phút: biểu đồ và thống kê bao gồm toàn bộ
          nhóm trung vị giao với khoảng chọn, không chỉ các mẫu nằm bên trong cận.
        </p>
      )}

      <div className="grid grid-cols-1 gap-3">
        <ClimateChart points={points} from={from} to={to} loading={chartsLoading} />
        <LightChart points={points} from={from} to={to} loading={chartsLoading} />
        <DustChart points={points} from={from} to={to} loading={chartsLoading} />
      </div>
    </div>
  );
}
