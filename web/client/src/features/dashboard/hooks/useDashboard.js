import { useEffect, useRef, useState } from 'react';
import { applyTheme, readTheme, saveTheme } from '../../../app/theme.js';
import { readFilters, saveFilters } from '../preferences.mjs';
import { useAvailability } from './useAvailability.js';
import { useDevices } from './useDevices.js';
import { useLiveStream } from './useLiveStream.js';
import { useReadings } from './useReadings.js';
import { newestReading, selectStatReading } from '../lib/latestReading.mjs';
import { cacheNotice } from '../lib/cacheNotice.mjs';

export function useDashboard() {
  const [saved] = useState(() => readFilters());
  const [period, setPeriod] = useState(saved.period);
  const [liveReading, setLiveReading] = useState(null);
  const [selected, setSelected] = useState(saved.device);
  const [theme, setTheme] = useState(() => readTheme());

  useEffect(() => { saveFilters(period, selected); }, [period, selected]);
  useEffect(() => { applyTheme(theme); }, [theme]);
  const [devicesKey, setDevicesKey] = useState(0);

  const devices = useDevices(devicesKey);
  const device = selected || devices[0]?.device || '';
  useEffect(() => {
    if (!selected && device) setSelected(device);
  }, [device, selected]);
  // Recent reads must not wait for (or trigger) historical availability scans.
  const availability = useAvailability(period.mode === 'dates' ? device : '', '', period.dates ?? []);
  const available = availability.data;
  useEffect(() => {
    if (period.mode !== 'dates' || !available) return;
    const dates = available.validDates.length ? available.validDates : available.last ? [available.last] : [];
    if (dates.join(',') !== period.dates.join(',')) setPeriod({ mode: 'dates', dates });
  }, [available, period]);
  const validPeriod = period.mode === 'recent' ? period
    : { mode: 'dates', dates: available && available.validDates.length === period.dates.length ? period.dates : [] };
  const { data, error, loading, reload, requestRefresh } = useReadings(validPeriod, device, 30000);

  const { status, connected } = useLiveStream((reading) => {
    if (!devices.some((d) => d.device === reading.device)) {
      setDevicesKey((k) => k + 1);
    }
    if (reading.device === device) {
      setLiveReading((previous) => newestReading(device, previous, reading));
      if (period.mode === 'recent') requestRefresh();
    }
  });

  // Khi Firebase vua tai xong lich su (hoac ket noi lai) thi nap lai danh sach thiet bi.
  const loadedAt = status?.loadedAt;
  const handledLoad = useRef(null);
  useEffect(() => {
    if (loadedAt && handledLoad.current !== loadedAt) {
      handledLoad.current = loadedAt;
      setDevicesKey((k) => k + 1);
      reload();
    }
  }, [loadedAt, reload]);

  // Truot cua so thoi gian ca khi thiet bi ngung gui.
  useEffect(() => {
    const id = setInterval(() => {
      if (period.mode === 'recent') reload();
      setDevicesKey((k) => k + 1);
    }, 30 * 1000);
    return () => clearInterval(id);
  }, [reload, period]);

  const cachedDataNotice = period.mode === 'recent' ? cacheNotice(data, status) : null;
  const points = data?.points ?? [];
  const from = data?.from ?? Date.now() - 3600 * 1000;
  const to = data?.to ?? Date.now();
  const current = devices.find((d) => d.device === device);
  const statReading = selectStatReading(period.mode, device, data, liveReading);
  // lastSeen is only a liveness hint, never a source of sensor values.
  const liveLatest = [newestReading(device, data?.liveLatest, liveReading),
    current ? { time: current.lastSeen } : null].filter(Boolean).sort((a, b) => b.time - a.time)[0];

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    saveTheme(next);
  }

  return {
    period, setPeriod, selected, setSelected, theme, toggleTheme,
    devices, device, availability, available, data, error, loading, reload,
    status, connected, cachedDataNotice, points, from, to, statReading, liveLatest,
  };
}
