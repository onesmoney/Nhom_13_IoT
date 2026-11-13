import { useEffect, useMemo, useState } from 'react';
import { fetchAvailability } from '../api.js';
import { availabilityView, settleAvailability } from '../lib/availabilityState.mjs';

// Fetch the oldest day once per device/open; month and selection stay local.
export function useAvailability(device) {
  const params = new URLSearchParams({ device });
  const key = params.toString();
  const [result, setResult] = useState(null);
  const [retry, setRetry] = useState(0);
  const scope = useMemo(() => ({ device }), [device]);
  const request = useMemo(() => ({ scope, key }), [scope, key, retry]);
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

