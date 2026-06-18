"""TTL-aware LRU cache with O(1) get and put operations."""

import threading
import time
from collections import OrderedDict
from typing import Any, Optional


class TTLCache:
    """
    A thread-safe, TTL-aware LRU cache.

    Time complexity:
        get: O(1) average
        put: O(n) worst-case only when a full purge of expired entries is
             needed at capacity; O(1) average when no purge is required.
             The ordered-dict move_to_end and popitem operations are O(1).
    """

    def __init__(self, capacity: int, default_ttl: float) -> None:
        if capacity < 1:
            raise ValueError("capacity must be >= 1")
        self._capacity: int = capacity
        self._default_ttl: float = default_ttl
        # OrderedDict maps key -> [value, expiry_timestamp]
        self._cache: OrderedDict = OrderedDict()
        self._lock: threading.Lock = threading.Lock()
        self._hits: int = 0
        self._misses: int = 0
        self._evictions: int = 0
        self._expirations: int = 0

    # ------------------------------------------------------------------
    # Internal helpers (must be called with self._lock held)
    # ------------------------------------------------------------------

    def _is_expired(self, expiry: float) -> bool:
        return time.monotonic() >= expiry

    def _purge_expired(self) -> int:
        """Remove all expired entries; return count removed."""
        now = time.monotonic()
        expired_keys = [k for k, (_, exp) in self._cache.items() if now >= exp]
        for k in expired_keys:
            del self._cache[k]
            self._expirations += 1
        return len(expired_keys)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get(self, key: Any, default: Any = None) -> Any:
        with self._lock:
            if key not in self._cache:
                self._misses += 1
                return default
            value, expiry = self._cache[key]
            if self._is_expired(expiry):
                del self._cache[key]
                self._expirations += 1
                self._misses += 1
                return default
            # Mark as most-recently-used
            self._cache.move_to_end(key)
            self._hits += 1
            return value

    def put(self, key: Any, value: Any, ttl: Optional[float] = None) -> None:
        effective_ttl = ttl if ttl is not None else self._default_ttl
        expiry = time.monotonic() + effective_ttl
        with self._lock:
            if key in self._cache:
                # Update existing entry and mark as MRU
                self._cache[key] = [value, expiry]
                self._cache.move_to_end(key)
                return
            # New key: ensure room
            if len(self._cache) >= self._capacity:
                self._purge_expired()
                # If still at capacity, evict the LRU live entry
                if len(self._cache) >= self._capacity:
                    self._cache.popitem(last=False)
                    self._evictions += 1
            self._cache[key] = [value, expiry]

    def __len__(self) -> int:
        now = time.monotonic()
        with self._lock:
            return sum(1 for _, (_, exp) in self._cache.items() if now < exp)

    def stats(self) -> dict:
        with self._lock:
            return {
                "hits": self._hits,
                "misses": self._misses,
                "evictions": self._evictions,
                "expirations": self._expirations,
            }
