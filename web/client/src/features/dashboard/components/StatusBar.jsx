import { formatAgo, formatDateTime } from '../lib/format.js';
import { useNow } from '../../../hooks/useNow.js';

// ESP32 gui moi 5s: qua nguong nay khong co ban ghi moi -> coi la offline.
const DEVICE_TIMEOUT_MS = 30 * 1000;
const pill = 'inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-[5px] text-[13px]';
const states = { ok: 'text-success', warn: 'text-warning', err: 'text-danger' };
const dot = 'size-2 shrink-0 rounded-full bg-current';

export function DeviceState({ latest, stale = false }) {
  const now = useNow(1000);
  if (!latest) return null;
  const online = !stale && now - latest.time < DEVICE_TIMEOUT_MS;
  return (
    <span className={`${pill} ${online ? states.ok : states.warn}`} title={formatDateTime(latest.time)}>
      <span className={`${dot} ${online ? 'motion-safe:animate-pulse' : ''}`} />
      {stale ? 'Chưa xác nhận trạng thái thiết bị' : online ? 'Thiết bị đang gửi' : 'Thiết bị offline'} · cập nhật {formatAgo(latest.time)}
    </span>
  );
}

export function ConnectionState({ connected, status }) {
  let cls = 'warn';
  let text = 'Mất kết nối server';
  if (connected && status) {
    if (status.firebase === 'online') {
      cls = 'ok';
      text = 'Firebase realtime';
    } else if (status.firebase === 'connecting') {
      text = 'Đang kết nối Firebase…';
    } else if (status.firebase === 'offline') {
      text = 'Firebase mất kết nối, đang thử lại…';
    } else {
      cls = 'err';
      text = 'Lỗi Firebase';
    }
  }
  return (
    <span className={`${pill} ${states[cls]}`}>
      <span className={`${dot} ${cls === 'ok' ? 'motion-safe:animate-pulse' : ''}`} />
      {text}
    </span>
  );
}
