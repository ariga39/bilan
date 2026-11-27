"""Measurement helpers shared by the shipper behaviour tests.

The shipper process is what must stay small, so these helpers instrument the
in-process shipper run directly: one counts bytes read from a concrete source
path through ``builtins.open`` and the other records the ``tracemalloc`` peak.
"""

from __future__ import annotations

import builtins
import contextlib
import os
import tracemalloc
from typing import Any, Iterator
from unittest import mock


class _CountingFile:
    def __init__(self, handle: Any, counter: dict[str, int]):
        self._handle = handle
        self._counter = counter

    def read(self, *args: Any, **kwargs: Any) -> Any:
        data = self._handle.read(*args, **kwargs)
        if isinstance(data, (bytes, bytearray)):
            self._counter["bytes"] += len(data)
        return data

    def readline(self, *args: Any, **kwargs: Any) -> Any:
        data = self._handle.readline(*args, **kwargs)
        if isinstance(data, (bytes, bytearray)):
            self._counter["bytes"] += len(data)
        return data

    def __iter__(self) -> Any:
        return iter(self._handle)

    def __enter__(self) -> "_CountingFile":
        self._handle.__enter__()
        return self

    def __exit__(self, *args: Any) -> Any:
        return self._handle.__exit__(*args)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._handle, name)


@contextlib.contextmanager
def measure_read_bytes(target: str) -> Iterator[dict[str, int]]:
    """Count bytes read from ``target`` while the shipper code runs."""

    resolved = os.path.abspath(target)
    counter = {"bytes": 0}
    real_open = builtins.open

    def metered_open(file: Any, mode: str = "r", *args: Any, **kwargs: Any) -> Any:
        handle = real_open(file, mode, *args, **kwargs)
        try:
            is_target = os.path.abspath(os.fspath(file)) == resolved
        except TypeError:
            is_target = False
        if is_target and "r" in mode and "+" not in mode:
            return _CountingFile(handle, counter)
        return handle

    with mock.patch("builtins.open", metered_open):
        yield counter


@contextlib.contextmanager
def measure_peak_bytes() -> Iterator[dict[str, int]]:
    """Record the tracemalloc peak while the shipper code runs."""

    result = {"peak": 0}
    tracemalloc.start()
    try:
        yield result
    finally:
        result["peak"] = tracemalloc.get_traced_memory()[1]
        tracemalloc.stop()
