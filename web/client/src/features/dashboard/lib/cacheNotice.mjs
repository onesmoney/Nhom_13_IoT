export function cacheNotice(data, status) {
  if (data?.stale !== true && !(data?.cache?.available && data.cache.stale)
    && !(status?.cache?.available && status.cache.stale)) return null;
  return 'Đang hiển thị dữ liệu đã lưu trong cache. Backend chưa đối soát xong với Firebase; dữ liệu có thể chưa bao gồm các thay đổi mới nhất.';
}
