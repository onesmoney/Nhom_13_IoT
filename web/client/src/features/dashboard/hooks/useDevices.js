import { useEffect, useState } from 'react';
import { fetchDevices } from '../api.js';

export function useDevices(refreshKey) {
  const [devices, setDevices] = useState([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    fetchDevices()
      .then((d) => alive && setDevices(d))
      .catch(() => {})
      .finally(() => { if (alive) setReady(true); });
    return () => {
      alive = false;
    };
  }, [refreshKey]);
  return { devices, loading: !ready };
}

