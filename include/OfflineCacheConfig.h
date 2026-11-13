#pragma once
#include <stddef.h>
#include <stdint.h>

// Fixed sampling cadence. Capacity can shrink if the filesystem lacks space.
constexpr uint32_t OFFLINE_CACHE_MINUTES = 30;
constexpr size_t OFFLINE_CACHE_MAX_BYTES = 256 * 1024;
constexpr size_t OFFLINE_CACHE_FS_RESERVE = 64 * 1024;
