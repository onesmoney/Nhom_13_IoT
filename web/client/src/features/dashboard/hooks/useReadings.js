import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchReadings } from '../api.js';

// Du lieu bieu do cho khoang thoi gian + thiet bi dang chon.
// Ban ghi moi den qua SSE chi danh dau "can nap lai"; viec nap lai bi gioi
// han toi da 1 lan / minRefreshMs de khong ban API moi 5 giay voi khoang 24h.
export function useReadings(period, device, minRefreshMs) {
  const enabled = !!device && (period.mode === 'recent' || period.dates.length > 0);
  const params = new URLSearchParams(period.mode === 'recent'
    ? { range: period.range }
    : { dates: period.dates.join(',') });
  if (device) params.set('device', device);
  const key = params.toString();
  const [result, setResult] = useState(null);
  const lastFetch = useRef(0);
  const timer = useRef(null);
  const request = useRef(null);

  const load = useCallback(async () => {
    clearTimeout(timer.current);
    timer.current = null;
    if (!enabled) return;
    // Do not repeatedly abort a slow historical query when SSE arrives.
    if (request.current?.key === key && !request.current.done) return;
    request.current?.controller.abort();
    const current = { key, controller: new AbortController(), done: false };
    request.current = current;
    lastFetch.current = Date.now();
    try {
      const data = await fetchReadings(key, current.controller.signal);
      if (request.current === current && !current.controller.signal.aborted) {
        setResult({ key, data, error: null });
      }
    } catch (err) {
      if (request.current === current && !current.controller.signal.aborted) {
        setResult({ key, data: null, error: err.message });
      }
    } finally {
      current.done = true;
    }
  }, [key, enabled]);

  useEffect(() => {
    setResult(null);
    load();
    return () => {
      clearTimeout(timer.current);
      request.current?.controller.abort();
      request.current = null;
    };
  }, [load]);

  const requestRefresh = useCallback(() => {
    if (timer.current) return;
    const wait = Math.max(0, lastFetch.current + minRefreshMs - Date.now());
    timer.current = setTimeout(load, wait);
  }, [load, minRefreshMs]);

  const visible = result?.key === key ? result : null;
  return { data: visible?.data, error: visible?.error, loading: enabled && !visible, reload: load, requestRefresh };
}

