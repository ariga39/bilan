"""Shared Python 3 standard-library helpers for bilan host shippers.

The helpers here are intentionally small and transport-oriented: a
cross-platform single-instance lock, atomic JSON state persistence, strict UTC
timestamp handling, deterministic JSON encoding, and the scoped Bearer-token
push client. Source-specific collection and aggregation stay in each shipper.
"""

from __future__ import annotations

import errno
import http.client
import json
import os
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, Mapping, Optional

SCHEMA_VERSION = 1
MAX_PAYLOAD_ROWS = 500
MAX_PAYLOAD_BYTES = 512 * 1024
REQUEST_TIMEOUT_SECONDS = 15


class ShipperError(Exception):
    """A fatal, operator-visible shipper error with no secret material."""


class LockHeldError(ShipperError):
    """Another process already owns this shipper state."""


class HTTPPushError(ShipperError):
    """A push attempt did not receive a 2xx ACK."""

    def __init__(self, message: str, status: Optional[int] = None, transient: bool = True):
        super().__init__(message)
        self.status = status
        self.transient = transient


def parse_utc_timestamp(value: Any) -> datetime:
    """Parse a canonical UTC ISO-8601 timestamp into an aware UTC datetime.

    Debitmetre writes ``YYYY-MM-DDTHH:MM:SSZ``. Offsets and fractional seconds
    are accepted as well so the shipper stays correct across harmless
    serialization differences.
    """

    if not isinstance(value, str):
        raise ValueError("timestamp is not a string")
    text = value.strip()
    if not text:
        raise ValueError("timestamp is empty")
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ValueError("timestamp is not ISO-8601") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def utc_hour_start(value: datetime) -> str:
    """Return the inclusive UTC hour start as ``YYYY-MM-DDTHH:00:00Z``."""

    hour = value.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    return hour.strftime("%Y-%m-%dT%H:00:00Z")


def utc_now_iso() -> str:
    """Return the current UTC time in the canonical second-precision form."""

    return datetime.now(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def canonical_json_bytes(value: Any) -> bytes:
    """Encode JSON deterministically so a retry sends byte-identical content."""

    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def envelope(batch_seq: int, usage_buckets: list[dict[str, Any]]) -> Dict[str, Any]:
    """Build the unified Push envelope with only the touched usage kind."""

    return {
        "schema_version": SCHEMA_VERSION,
        "batch_seq": batch_seq,
        "usage_buckets": usage_buckets,
        "quota_observations": [],
        "balance_snapshots": [],
    }


def atomic_write_json(path: str, value: Any) -> None:
    """Atomically replace a JSON file with mode 0600 where supported."""

    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".tmp-bilan-", dir=directory, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, sort_keys=True, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass
        os.replace(temporary, path)
    finally:
        try:
            if os.path.exists(temporary):
                os.unlink(temporary)
        except OSError:
            pass


def load_json_file(path: str) -> Optional[Any]:
    """Read a JSON file, returning ``None`` when it does not exist."""

    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        raise ShipperError("cannot read state file: %s" % exc.__class__.__name__) from exc


class InstanceLock:
    """Advisory non-blocking single-writer lock (flock or msvcrt)."""

    def __init__(self, path: str):
        self.path = path
        self._fd: Optional[int] = None

    def __enter__(self) -> "InstanceLock":
        self.acquire()
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        self.release()

    def acquire(self) -> None:
        directory = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(directory, exist_ok=True)
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            if os.name == "nt":
                import msvcrt

                if os.fstat(fd).st_size == 0:
                    os.write(fd, b"\0")
                    os.lseek(fd, 0, os.SEEK_SET)
                try:
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                except OSError as exc:
                    raise LockHeldError("another shipper instance holds the lock") from exc
            else:
                import fcntl

                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError as exc:
                    if exc.errno in (errno.EACCES, errno.EAGAIN):
                        raise LockHeldError("another shipper instance holds the lock") from exc
                    raise
        except Exception:
            os.close(fd)
            raise
        self._fd = fd

    def release(self) -> None:
        if self._fd is None:
            return
        fd = self._fd
        self._fd = None
        try:
            if os.name == "nt":
                import msvcrt

                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def post_envelope(
    endpoint: str,
    token: str,
    payload: Mapping[str, Any],
    timeout_seconds: float = REQUEST_TIMEOUT_SECONDS,
) -> None:
    """POST one envelope with a scoped Bearer token.

    A 2xx response is the only success. 4xx responses are permanent (the same
    payload should not be retried blindly); 408/429/5xx and transport failures
    are transient and keep the durable outbox pending.
    """

    body = canonical_json_bytes(payload)
    if len(body) > MAX_PAYLOAD_BYTES:
        raise HTTPPushError(
            "payload exceeds %d bytes" % MAX_PAYLOAD_BYTES,
            status=None,
            transient=False,
        )
    request = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "bilan-debitmetre-shipper/1",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            status = response.getcode()
            response.read(64 * 1024)
    except urllib.error.HTTPError as exc:
        status = exc.code
        transient = status in (408, 429) or 500 <= status <= 599
        raise HTTPPushError(
            "ingest rejected batch with HTTP %d" % status,
            status=status,
            transient=transient,
        ) from None
    except (urllib.error.URLError, http.client.HTTPException, OSError) as exc:
        reason = getattr(exc, "reason", None) or exc.__class__.__name__
        raise HTTPPushError(
            "ingest transport failure: %s" % reason,
            status=None,
            transient=True,
        ) from None
    if not 200 <= status <= 299:
        raise HTTPPushError(
            "ingest rejected batch with HTTP %d" % status,
            status=status,
            transient=False,
        )


def split_payload_rows(rows: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Split rows into contract-sized batches (500 rows per request)."""

    if not rows:
        return [[]]
    return [rows[index : index + MAX_PAYLOAD_ROWS] for index in range(0, len(rows), MAX_PAYLOAD_ROWS)]

