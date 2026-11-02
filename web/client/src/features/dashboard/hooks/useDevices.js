import { useEffect, useState } from 'react';
import { fetchDevices } from '../api.js';

export function useDevices(refreshKey) {
  const [devices, setDevices] = useState([]);
  useEffect(() => {
    let alive = true;
    fetchDevices()
      .then((d) => alive && setDevices(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [refreshKey]);
  return devices;
}

