#pragma once
#include <FS.h>
#include <vector>
#include "CachedReading.h"

// Caller holds the storage mutex. Network requests never hold it.
class OfflineQueue {
public:
  explicit OfflineQueue(fs::FS &fs) : _fs(fs) {}
  bool begin(size_t maxRecords);
  bool append(CachedReading reading);
  bool peek(CachedReading &reading, uint64_t &ticket);
  bool replaceHead(uint64_t ticket, CachedReading reading);
  bool acknowledge(uint64_t ticket, bool dropped = false);
  size_t count() const { return _count; }
  size_t capacity() const { return _capacity; }
  uint32_t dropped() const { return _checkpoint.dropped; }
private:
  static constexpr uint32_t RecordsPerSegment = 32;
  struct Segment { uint32_t id; uint32_t records; };
  struct Checkpoint {
    uint32_t magic = 0x3143514f; // OQC1
    uint32_t generation = 0;
    uint64_t next = 0;
    uint32_t dropped = 0;
    uint32_t crc = 0;
  } _checkpoint;
  static_assert(sizeof(Checkpoint) == 24, "Unexpected checkpoint layout");
  fs::FS &_fs;
  std::vector<Segment> _segments;
  size_t _capacity = 0, _count = 0;
  uint64_t _head = 0, _tail = 0;
  bool _ready = false;
  String segmentPath(uint32_t id) const;
  bool readAt(uint64_t position, CachedReading &reading);
  bool saveCheckpoint(uint64_t next, bool dropped);
  void normalizeHead();
  void reclaim();
};
