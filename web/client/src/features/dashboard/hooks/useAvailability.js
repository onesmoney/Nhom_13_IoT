import { useEffect, useMemo, useState } from 'react';
import { fetchAvailability } from '../api.js';
import { availabilityView, settleAvailability } from '../lib/availabilityState.mjs';

// Keyed/abortable so a previous device or month can never enable stale dates.
export function useAvailability(device, month = '', dates = [], refreshKey = 0) {
  const params = new URLSearchParams({ device });
  if (month) params.set('month', month);
  if (dates.length) params.set('dates', dates.join(','));
  const key = params.toString();
  const [result, setResult] = useState(null);
  const [retry, setRetry] = useState(0);
  const scope = useMemo(() => ({ device, month }), [device, month]);
  const request = useMemo(() => ({ scope, key }), [scope, key, refreshKey, retry]);
  useEffect(() => {
    if (!device) return;
    const controller = new AbortController();
    fetchAvailability(request.key, controller.signal)
      .then((data) => setResult((previous) => settleAvailability(previous, request, controller.signal, { data })))
      .catch((err) => setResult((previous) => settleAvailability(previous, request, controller.signal, { error: err.message })));
    return () => controller.abort();
  }, [device, request]);
  return { ...availabilityView(result, request, !!device), reload: () => setRetry((n) => n + 1) };
}

