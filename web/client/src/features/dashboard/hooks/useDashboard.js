import { useEffect, useRef, useState } from 'react';
import { applyTheme, readTheme, saveTheme } from '../../../app/theme.js';
import { readFilters, saveFilters } from '../preferences.mjs';
import { useDevices } from './useDevices.js';
import { useLiveStream } from './useLiveStream.js';
import { useReadings } from './useReadings.js';
import { newestReading, selectStatReading } from '../lib/latestReading.mjs';
import { cacheNotice } from '../lib/cacheNotice.mjs';
import { chartTimeDomain } from '../lib/chartDomain.js';

export function useDashboard() {
  const [saved] = useState(() => readFilters());
  const [period, setPeriod] = useState(saved.period);
  const [liveReading, setLiveReading] = useState(null);
  const [selected, setSelected] = useState(saved.device);
  const [theme, setTheme] = useState(() => readTheme());

  useEffect(() => { saveFilters(period, selected); }, [period, selected]);
  useEffect(() => { applyTheme(theme); }, [theme]);
  const [devicesKey, setDevicesKey] = useState(0);

  const { devices, loading: devicesLoading } = useDevices(devicesKey);
  const device = selected || devices[0]?.device || '';
  useEffect(() => {
    if (!selected && device) setSelected(device);
  }, [device, selected]);
  // Apply reads the requested days directly, preserving empty days/selections.
  const { data, error, loading, refreshing, reload, requestRefresh } = useReadings(period, device, 30000);

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
  // Keep initial placeholders visible while discovering a device or waiting
  // for the backend's first synchronization. Background polling keeps charts.
  const chartsLoading = loading || (!device && (devicesLoading || status?.firebase === 'connecting'));
  const points = data?.points ?? [];
  const [from, to] = chartTimeDomain(points,
    data?.from ?? Date.now() - 3600 * 1000,
    data?.to ?? Date.now(), period.mode === 'dates');
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
    devices, device, data, error, loading, chartsLoading, refreshing, reload,
    status, connected, cachedDataNotice, points, from, to, statReading, liveLatest,
  };
}
