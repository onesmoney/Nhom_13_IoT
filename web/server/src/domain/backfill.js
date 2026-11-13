// Markers are written atomically with historical samples under the same RTDB
// parent. Their revision is a persisted sample key, so retries are harmless.
export function validateBackfill(device, value) {
  if (typeof device !== 'string' || !device || device.length > 256 ||
      !value || typeof value !== 'object' ||
      typeof value.revision !== 'string' || !/^[-0-9A-Z_a-z]{20}$/.test(value.revision) ||
      !Number.isSafeInteger(value.from) || value.from < 0 ||
      !Number.isSafeInteger(value.to) || value.to < value.from || value.to > 8.64e15 ||
      !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) {
    throw new Error('Invalid device backfill marker');
  }
  return { device, revision: value.revision, from: value.from, to: value.to };
}
