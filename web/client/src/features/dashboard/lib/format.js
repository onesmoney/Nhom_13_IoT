export const RANGES = [
  { value: '15m', label: '15 phút', ms: 15 * 60 * 1000 },
  { value: '1h', label: '1 giờ', ms: 3600 * 1000 },
  { value: '6h', label: '6 giờ', ms: 6 * 3600 * 1000 },
  { value: '24h', label: '24 giờ', ms: 24 * 3600 * 1000 },
];

const pad = (n) => String(n).padStart(2, '0');

export function formatAxisTime(ms) {
  const d = new Date(ms + 7 * 3600000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function formatDateTime(ms) {
  const d = new Date(ms + 7 * 3600000);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${formatAxisTime(ms)}:${pad(d.getUTCSeconds())}`;
}

export function formatValue(value, digits = 1) {
  if (value === null || value === undefined) return '--';
  return Number(value).toLocaleString('vi-VN', {
    maximumFractionDigits: digits,
  });
}

export function formatAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} giây trước`;
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  return `${Math.floor(s / 86400)} ngày trước`;
}

// Nguong PM2.5 (ug/m3, trung binh 24h) theo US EPA 2024.
const PM25_LEVELS = [
  { max: 9, label: 'Tốt', color: '#16a34a' },
  { max: 35.4, label: 'Trung bình', color: '#ca8a04' },
  { max: 55.4, label: 'Kém', color: '#ea580c' },
  { max: 125.4, label: 'Xấu', color: '#dc2626' },
  { max: 225.4, label: 'Rất xấu', color: '#9333ea' },
  { max: Infinity, label: 'Nguy hại', color: '#7f1d1d' },
];

export function pm25Level(value) {
  if (value === null || value === undefined) return null;
  return PM25_LEVELS.find((l) => value <= l.max);
}

export function signalLevel(rssi) {
  if (rssi === null || rssi === undefined) return null;
  if (rssi >= -55) return { label: 'Rất mạnh', color: '#16a34a' };
  if (rssi >= -67) return { label: 'Tốt', color: '#65a30d' };
  if (rssi >= -75) return { label: 'Trung bình', color: '#ca8a04' };
  return { label: 'Yếu', color: '#dc2626' };
}
