export function readingResolution(reading) {
  const aggregate = reading?.aggregation;
  if (!aggregate || aggregate.method !== 'median') return 'Dữ liệu gốc';
  return `Trung vị ${aggregate.bucketMinutes} phút · ${aggregate.sourceCount} mẫu`;
}
