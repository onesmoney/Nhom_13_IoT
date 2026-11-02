import { useEffect, useEffectEvent, useState } from 'react';
import { openLiveStream } from '../api.js';

// Trang thai server + Firebase, cap nhat qua Server-Sent Events.
// Moi ban ghi moi tu ESP32 goi onReading (de nap lai bieu do).
export function useLiveStream(onReading) {
  const [status, setStatus] = useState(null);
  const [connected, setConnected] = useState(false);
  const handleReading = useEffectEvent((reading) => onReading(reading));

  useEffect(() => {
    const es = openLiveStream();
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener('status', (e) => setStatus(JSON.parse(e.data)));
    es.addEventListener('reading', (e) => handleReading(JSON.parse(e.data)));
    return () => es.close();
  }, []);

  return { status, connected };
}

