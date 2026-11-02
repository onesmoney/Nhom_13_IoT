import { useEffect, useState } from 'react';

// Re-render dinh ky de cac nhan "x giay truoc" tu cap nhat.
export function useNow(intervalMs) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
