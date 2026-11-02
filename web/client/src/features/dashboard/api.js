import { fetchJson } from '../../lib/http.js';

export function fetchDevices() {
  return fetchJson('/api/devices');
}

export function fetchAvailability(key, signal) {
  return fetchJson(`/api/availability?${key}`, signal);
}

export function fetchReadings(key, signal) {
  return fetchJson(`/api/readings?${key}`, signal);
}

export function openLiveStream() {
  return new EventSource('/api/stream');
}
