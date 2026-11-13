#include "OfflineQueue.h"
#include <algorithm>
#include <string.h>

String OfflineQueue::segmentPath(uint32_t id) const {
  char path[40];
  snprintf(path, sizeof(path), "/offline-v1/q%08lx.bin", static_cast<unsigned long>(id));
  return String(path);
}

bool OfflineQueue::begin(size_t maxRecords) {
  _ready = false; _segments.clear(); _count = 0; _capacity = maxRecords;
  _checkpoint = Checkpoint{};
  if (!_capacity || (!_fs.exists("/offline-v1") && !_fs.mkdir("/offline-v1"))) return false;
  bool foundCheckpoint = false;
  for (unsigned slot = 0; slot < 2; ++slot) {
    const char *path = slot ? "/offline-v1/ack1" : "/offline-v1/ack0";
    File file = _fs.open(path, "r"); Checkpoint candidate;
    if (file && file.size() == sizeof(candidate) &&
        file.read(reinterpret_cast<uint8_t *>(&candidate), sizeof(candidate)) == sizeof(candidate) &&
        candidate.magic == _checkpoint.magic &&
        candidate.crc == cacheCrc(&candidate, offsetof(Checkpoint, crc)) &&
        (!foundCheckpoint || static_cast<int32_t>(candidate.generation - _checkpoint.generation) > 0)) {
      _checkpoint = candidate; foundCheckpoint = true;
    }
    file.close();
  }
  File directory = _fs.open("/offline-v1", "r");
  if (!directory || !directory.isDirectory()) return false;
  for (File file = directory.openNextFile(); file; file = directory.openNextFile()) {
    const char *name = strrchr(file.name(), '/'); name = name ? name + 1 : file.name();
    unsigned long id; int consumed = 0;
    if (!file.isDirectory() && strlen(name) == 13 &&
        sscanf(name, "q%8lx.bin%n", &id, &consumed) == 1 && consumed == 13) {
      // A torn tail is one invalid record. peek() accounts for and skips it.
      if (file.size() > RecordsPerSegment * sizeof(CachedReading)) return false;
      _segments.push_back({static_cast<uint32_t>(id),
          static_cast<uint32_t>((file.size() + sizeof(CachedReading) - 1) / sizeof(CachedReading))});
    }
    file.close();
  }
  directory.close();
  std::sort(_segments.begin(), _segments.end(), [](const Segment &a, const Segment &b) { return a.id < b.id; });
  _head = _checkpoint.next;
  _tail = _segments.empty() ? ((_head + RecordsPerSegment - 1) / RecordsPerSegment) * RecordsPerSegment
      : (static_cast<uint64_t>(_segments.back().id) + 1) * RecordsPerSegment;
  // Reuse a complete tail across boots; frequent resets must not consume one
  // filesystem block per sample. A torn/unverifiable tail starts a new segment.
  if (!_segments.empty() && _segments.back().records < RecordsPerSegment) {
    const auto &last = _segments.back();
    File file = _fs.open(segmentPath(last.id), "r");
    CachedReading record;
    const bool complete = file && file.size() % sizeof(record) == 0;
    file.close();
    if (complete && (!last.records || readAt(static_cast<uint64_t>(last.id) * RecordsPerSegment + last.records - 1, record)))
      _tail = static_cast<uint64_t>(last.id) * RecordsPerSegment + last.records;
  }
  for (const auto &s : _segments) {
    const uint64_t start = static_cast<uint64_t>(s.id) * RecordsPerSegment;
    if (start + s.records > _head) _count += start >= _head ? s.records : start + s.records - _head;
  }
  _ready = true;
  normalizeHead(); reclaim();
  while (_count > _capacity) if (!acknowledge(_head, true)) return _ready = false;
  return true;
}

void OfflineQueue::normalizeHead() {
  for (const auto &s : _segments) {
    const uint64_t start = static_cast<uint64_t>(s.id) * RecordsPerSegment;
    if (_head < start + s.records) { if (_head < start) _head = start; return; }
  }
  _head = _tail;
}

void OfflineQueue::reclaim() {
  // Delete only after a durable checkpoint. Failed deletes are retried later.
  while (!_segments.empty()) {
    const auto &s = _segments.front();
    if ((static_cast<uint64_t>(s.id) * RecordsPerSegment + s.records) > _checkpoint.next) break;
    // Do not unlink the partially filled segment currently receiving appends.
    if (_tail / RecordsPerSegment == s.id && _tail % RecordsPerSegment) break;
    if (!_fs.remove(segmentPath(s.id))) break;
    _segments.erase(_segments.begin());
  }
}

bool OfflineQueue::readAt(uint64_t position, CachedReading &reading) {
  File file = _fs.open(segmentPath(static_cast<uint32_t>(position / RecordsPerSegment)), "r");
  if (!file || !file.seek((position % RecordsPerSegment) * sizeof(reading))) return false;
  const bool ok = file.read(reinterpret_cast<uint8_t *>(&reading), sizeof(reading)) == sizeof(reading) &&
      reading.crc == cacheCrc(&reading, offsetof(CachedReading, crc));
  file.close(); return ok;
}

bool OfflineQueue::saveCheckpoint(uint64_t next, bool dropped) {
  Checkpoint candidate = _checkpoint;
  candidate.next = next; candidate.generation++; candidate.dropped += dropped;
  candidate.crc = cacheCrc(&candidate, offsetof(Checkpoint, crc));
  const char *path = candidate.generation & 1 ? "/offline-v1/ack1" : "/offline-v1/ack0";
  File file = _fs.open(path, "w");
  if (!file) return false;
  const bool wrote = file.write(reinterpret_cast<const uint8_t *>(&candidate), sizeof(candidate)) == sizeof(candidate);
  file.flush(); file.close();
  File check = _fs.open(path, "r"); Checkpoint verified;
  const bool ok = wrote && check && check.size() == sizeof(verified) &&
      check.read(reinterpret_cast<uint8_t *>(&verified), sizeof(verified)) == sizeof(verified) &&
      memcmp(&candidate, &verified, sizeof(candidate)) == 0;
  check.close();
  if (ok) _checkpoint = candidate;
  return ok;
}

bool OfflineQueue::acknowledge(uint64_t ticket, bool dropped) {
  // Producer may have evicted an in-flight head. Never ACK a different sample.
  if (!_ready || !_count || ticket != _head || !saveCheckpoint(ticket + 1, dropped)) return false;
  --_count; ++_head; normalizeHead(); reclaim(); return true;
}

bool OfflineQueue::peek(CachedReading &reading, uint64_t &ticket) {
  while (_ready && _count) {
    ticket = _head;
    if (readAt(ticket, reading)) return true;
    Serial.println("[CACHE] CRC/torn record: bo mau hong, giu cac mau con lai");
    if (!acknowledge(ticket, true)) return false;
  }
  return false;
}

bool OfflineQueue::append(CachedReading reading) {
  if (!_ready) return false;
  while (_count >= _capacity) if (!acknowledge(_head, true)) return false;
  if (_tail / RecordsPerSegment >= UINT32_MAX) return false;
  const uint32_t segment = static_cast<uint32_t>(_tail / RecordsPerSegment);
  const String path = segmentPath(segment);
  File file = _fs.open(path, "a");
  if (!file || file.size() != (_tail % RecordsPerSegment) * sizeof(reading)) return false;
  reading.crc = cacheCrc(&reading, offsetof(CachedReading, crc));
  const bool wrote = file.write(reinterpret_cast<const uint8_t *>(&reading), sizeof(reading)) == sizeof(reading);
  file.flush(); file.close();
  CachedReading verified;
  if (!wrote || !readAt(_tail, verified) || memcmp(&reading, &verified, sizeof(reading)) != 0) {
    // Reserve the damaged slot for recovery; do not append behind it.
    if (_segments.empty() || _segments.back().id != segment) _segments.push_back({segment, 0});
    _segments.back().records = (_tail % RecordsPerSegment) + 1;
    ++_count; _tail = (static_cast<uint64_t>(segment) + 1) * RecordsPerSegment;
    normalizeHead(); return false;
  }
  if (_segments.empty() || _segments.back().id != segment) _segments.push_back({segment, 0});
  _segments.back().records++; ++_tail; ++_count; normalizeHead(); reclaim(); return true;
}

bool OfflineQueue::replaceHead(uint64_t ticket, CachedReading reading) {
  if (!_ready || !_count || ticket != _head) return false;
  reading.crc = cacheCrc(&reading, offsetof(CachedReading, crc));
  File file = _fs.open(segmentPath(static_cast<uint32_t>(ticket / RecordsPerSegment)), "r+");
  if (!file || !file.seek((ticket % RecordsPerSegment) * sizeof(reading))) return false;
  const bool wrote = file.write(reinterpret_cast<const uint8_t *>(&reading), sizeof(reading)) == sizeof(reading);
  file.flush(); file.close(); CachedReading verified;
  return wrote && readAt(ticket, verified) && memcmp(&reading, &verified, sizeof(reading)) == 0;
}
