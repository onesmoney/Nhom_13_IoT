import { RANGE_MS, parseDate, calendarBounds, todayVN, selectedDates } from '../../../../shared/time.mjs';
import { createReadingsResponse } from '../../services/readingsResponse.js';

function validateDevice(device) {
  if (device !== undefined && (typeof device !== 'string' || !device.trim() || device.length > 256 || /[\u0000-\u001f\u007f]/.test(device))) throw new Error('Thiết bị không hợp lệ');
}

export function sendStoreError(res, store, error, fallback = 'Không tải được dữ liệu Firebase. Vui lòng thử lại.') {
  const status = store.status?.();
  const httpStatus = error.status || 503;
  const readiness = status?.readiness || error.readiness;
  if (httpStatus === 503) res.set('Retry-After', String(Math.ceil((readiness?.retryAfterMs || 15000) / 1000)));
  return res.status(httpStatus).json({
    error: error.status ? error.message : fallback,
    code: error.code || (httpStatus === 503 ? 'FIREBASE_UNAVAILABLE' : undefined),
    readiness,
    firebase: status?.firebase,
    connection: status?.connection,
    loadedAt: status?.loadedAt,
    sync: status?.sync,
    statusUrl: '/api/status',
  });
}

export function devicesHandler(store) {
  return async (_req, res) => {
    try {
      const cache = store.cacheStatus?.();
      if (store.aggregatePath && !cache?.available) store.assertReady();
      res.set?.('Cache-Control', 'no-store');
      res.set?.('X-Data-Source', cache?.stale ? `${cache.source}-cache-stale` : 'memory-reconciled');
      res.json(store.devices());
    } catch (error) { sendStoreError(res, store, error); }
  };
}

export function availabilityHandler(store) {
  return async (req, res) => {
    let dates;
    try {
      validateDevice(req.query.device);
      const month = req.query.month;
      if (month !== undefined && (typeof month !== 'string' || parseDate(`${month}-01`) === null || month < '1970-01' || month > todayVN().slice(0, 7))) throw new Error('Tháng không hợp lệ');
      dates = req.query.dates === undefined ? [] : selectedDates(req.query.dates);
    } catch (err) { return res.status(400).json({ error: err.message }); }
    try {
      res.json(await store.availability({ device: req.query.device, month: req.query.month, dates }));
    } catch (err) {
      sendStoreError(res, store, err, 'Không tải được ngày có dữ liệu Firebase. Vui lòng thử lại.');
    }
  };
}

export function parsePeriod(params, now = Date.now()) {
  validateDevice(params.device);
  if (params.dates !== undefined) {
    if (params.range !== undefined || params.date !== undefined || (params.mode !== undefined && params.mode !== 'dates')) throw new Error('Chỉ chọn danh sách ngày');
    const dates = selectedDates(params.dates, todayVN(now));
    return { dates, from: calendarBounds(dates[0]).from, to: calendarBounds(dates.at(-1)).to, historical: true };
  }
  for (const key of ['range', 'date', 'mode', 'device']) {
    if (params[key] !== undefined && typeof params[key] !== 'string') {
      throw new Error(`Tham số ${key} không hợp lệ`);
    }
  }
  if (params.date !== undefined) {
    if (parseDate(params.date) === null || params.date < '1970-01-01' || params.date > todayVN(now)) {
      throw new Error('Ngày không hợp lệ hoặc ở tương lai');
    }
    const mode = params.mode ?? 'day';
    if (!['day', 'week'].includes(mode) || params.range !== undefined) {
      throw new Error('Chọn ngày/tuần hoặc khoảng giờ, không chọn cả hai');
    }
    return { ...calendarBounds(params.date, mode), historical: true };
  }
  const range = params.range ?? '1h';
  if (!Object.hasOwn(RANGE_MS, range) || params.mode !== undefined) {
    throw new Error('Khoảng thời gian không hợp lệ');
  }
  return { from: now - RANGE_MS[range], to: now, historical: false };
}

export function readingsHandler(store) {
  return async (req, res) => {
    let period;
    try {
      period = parsePeriod(req.query);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const device = req.query.device || undefined;
    try {
      const body = await createReadingsResponse(store, { period, device });
      if (body.invalidDates) return res.status(400).json(body);
      if (!period.historical) res.set?.('X-Data-Source', body.dataSource);
      res.set?.('Cache-Control', 'no-store');
      res.json(body);
    } catch (err) {
      console.warn('Firebase history:', err.message);
      sendStoreError(res, store, err, 'Không tải được dữ liệu lịch sử Firebase. Vui lòng thử lại.');
    }
  };
}
