"""Small, payload-free, bounded local diagnostic log; never a credential store."""
from __future__ import annotations

import errno
import ctypes
import ctypes.wintypes
import json
import os
import re
import stat
import threading
import time
import uuid
import zipfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

RETENTION_DAYS = 7
DIRECTORY_BYTES = 20 * 1024 * 1024
FILE_BYTES = 2 * 1024 * 1024
EVENT_BYTES = 2 * 1024
LOCK_NAME = ".diagnostics.lock"
FILE_PATTERN = re.compile(r"^diagnostic-(\d{4}-\d{2}-\d{2})-(\d{6})\.jsonl$")
UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
EVENTS = frozenset("cli_started cli_finished installation_started preflight_result package_verified files_staged client_detection_result client_registration_result installation_finished launcher_started launcher_finished login_started login_finished listener_ready listener_failed browser_open_result authorization_waiting callback_rejected callback_accepted token_request_started token_request_result identity_result http_request_result profile_result diagnostic_exported".split())
PHASES = frozenset("start preflight download verify stage detect register login listener browser callback token identity profile export finish cleanup bridge".split())
OUTCOMES = frozenset("started succeeded failed rejected waiting unavailable cancelled skipped pending matched mismatch accepted denied not_attempted".split())
COMPONENTS = frozenset(("cli", "bridge", "installer", "bootstrap", "launcher"))
COMMANDS = frozenset("install repair uninstall login logout status doctor bridge version profile diagnostics tools".split())
ERROR_CODES = frozenset("unknown_error diagnostic_write_failed diagnostic_export_failed usage invalid_config configuration_required runtime_error auth_required endpoint_unavailable endpoint_redirect_rejected invalid_response invalid_token_response invalid_grant invalid_token invalid_client invalid_target invalid_scope temporarily_unavailable server_error refresh_failed token_exchange_failed access_denied oauth_state_mismatch oauth_issuer_mismatch oauth_callback_invalid oauth_callback_timeout callback_port_unavailable invalid_redirect browser_unavailable secure_storage_unavailable logout_remote_failed logout_remote_unavailable invalid_jsonrpc invalid_params mcp_http_error bridge_failed missing_server_info missing_modern_capabilities mcp_protocol_version_unsupported registration_rollback_required ownership_conflict unsafe_path skill_missing invalid_client_config client_config_changed install_failed install_failed_recovery_required post_install_failed preflight_failed package_verification_failed client_not_detected client_registration_failed profile_unavailable profile_invalid profile_unsafe_path profile_write_failed profile_identity_invalid profile_preferences_invalid profile_version_invalid".split())
ERROR_CODES |= frozenset("attempt_id_invalid codex_path_invalid client_probe_failed artifact_invalid installation_failed registration_failed login_failed identity_verification_failed permission_denied incomplete_install diagnostic_failed login_cancelled mcp_unavailable invalid_registration_mode profile_path_unsafe profile_storage_unavailable profile_data_invalid profile_incomplete profile_review_limit".split())
ERROR_CODES |= frozenset("tool_input_invalid tool_not_public tool_transport_failed tool_http_error tool_response_invalid tool_server_error tools_discovery_invalid".split())
_FIELDS = frozenset("timestamp component event phase attempt_id request_id server_trace_id pid parent_pid version command outcome duration_ms http_status exit_code error_code matched".split())
_THREAD_LOCKS: dict[str, threading.Lock] = {}
_GUARD = threading.Lock()


class DiagnosticError(RuntimeError):
    pass


def diagnostic_id(value: Any = None) -> str:
    """An identifier is diagnostic metadata only, never authentication."""
    if value is None or value == "":
        return str(uuid.uuid4())
    if not isinstance(value, str) or not UUID_PATTERN.fullmatch(value):
        raise ValueError("diagnostic identifier must be a canonical UUID")
    return value


def safe_error_code(value: Any) -> str:
    return value if isinstance(value, str) and value in ERROR_CODES else "unknown_error"


def _is_link(path: Path) -> bool:
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def _ensure_directory(path: Path) -> None:
    # Check each existing component before creating any child; do not resolve
    # a reparse point and accidentally make a new tree outside this namespace.
    for parent in reversed((path, *path.parents)):
        if parent.exists() or parent.is_symlink():
            if _is_link(parent) or not parent.is_dir():
                raise DiagnosticError("diagnostic directory is unsafe")
        else:
            try:
                parent.mkdir(mode=0o700)
            except FileExistsError:
                pass
            if _is_link(parent) or not parent.is_dir():
                raise DiagnosticError("diagnostic directory changed during creation")


def _regular(path: Path) -> os.stat_result:
    info = path.lstat()
    if _is_link(path) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise DiagnosticError("diagnostic file is unsafe")
    return info


def _open_regular(path: Path, *, create: bool = False, exclusive: bool = False) -> int:
    """Open a non-reparse regular file and verify the opened inode before use."""
    if path.exists() or path.is_symlink():
        _regular(path)
    flags = os.O_RDWR | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    if create:
        flags |= os.O_CREAT
    if exclusive:
        flags |= os.O_EXCL
    if os.name == "nt":
        import msvcrt
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        create_file = kernel.CreateFileW
        create_file.argtypes = (ctypes.wintypes.LPCWSTR, ctypes.wintypes.DWORD, ctypes.wintypes.DWORD, ctypes.wintypes.LPVOID, ctypes.wintypes.DWORD, ctypes.wintypes.DWORD, ctypes.wintypes.HANDLE)
        create_file.restype = ctypes.wintypes.HANDLE
        disposition = 1 if exclusive else (4 if create else 3)
        # Open the reparse point itself, not its target, on Windows as well.
        handle = create_file(str(path), 0xC0000000, 7, None, disposition, 0x00200080, None)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            fd = msvcrt.open_osfhandle(handle, os.O_RDWR | os.O_BINARY)
        except BaseException:
            kernel.CloseHandle.argtypes = (ctypes.wintypes.HANDLE,)
            kernel.CloseHandle(handle)
            raise
    else:
        fd = os.open(str(path), flags, 0o600)
    try:
        opened = os.fstat(fd)
        if stat.S_ISLNK(opened.st_mode) or bool(getattr(opened, "st_file_attributes", 0) & 0x400) or not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
            raise DiagnosticError("opened diagnostic file is unsafe")
        current = _regular(path)
        _ensure_directory(path.parent)
        if (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
            raise DiagnosticError("diagnostic file changed while opening")
        return fd
    except Exception:
        os.close(fd)
        raise


@contextmanager
def _directory_lock(root: Path, *, timeout: float = 0.25):
    _ensure_directory(root)
    key = os.path.normcase(str(root.absolute()))
    with _GUARD:
        local_lock = _THREAD_LOCKS.setdefault(key, threading.Lock())
    if not local_lock.acquire(timeout=timeout):
        raise DiagnosticError("diagnostic lock is busy")
    fd = None
    acquired = False
    try:
        fd = _open_regular(root / LOCK_NAME, create=True)
        if os.fstat(fd).st_size == 0:
            os.write(fd, b"\0")
        deadline = time.monotonic() + timeout
        while True:
            try:
                if os.name == "nt":
                    import msvcrt
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except OSError as exc:
                if exc.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK} or time.monotonic() >= deadline:
                    raise DiagnosticError("diagnostic lock is unavailable") from exc
                time.sleep(0.025)
        yield
    finally:
        if fd is not None:
            if acquired:
                try:
                    if os.name == "nt":
                        import msvcrt
                        os.lseek(fd, 0, os.SEEK_SET)
                        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(fd, fcntl.LOCK_UN)
                except OSError:
                    pass
            os.close(fd)
        local_lock.release()


def _timestamp(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        return None
    return parsed.isoformat()


def _safe_event(values: Mapping[str, Any]) -> dict[str, Any]:
    # Fixed enums prevent opaque text (including a token-shaped string) from
    # being smuggled into an otherwise innocuous field.
    result: dict[str, Any] = {}
    if not isinstance(values, Mapping):
        raise DiagnosticError("diagnostic record is not an object")
    if values.get("event") not in EVENTS or values.get("phase") not in PHASES:
        raise DiagnosticError("diagnostic event is not supported")
    for name, choices in (("event", EVENTS), ("phase", PHASES), ("component", COMPONENTS), ("outcome", OUTCOMES), ("command", COMMANDS)):
        value = values.get(name)
        if value in choices:
            result[name] = value
    stamp = _timestamp(values.get("timestamp"))
    if stamp:
        result["timestamp"] = stamp
    for name in ("attempt_id", "request_id", "server_trace_id"):
        value = values.get(name)
        if isinstance(value, str) and UUID_PATTERN.fullmatch(value):
            result[name] = value
    for name in ("pid", "parent_pid", "duration_ms", "http_status", "exit_code"):
        value = values.get(name)
        limit = 999 if name in {"http_status", "exit_code"} else 2**31 - 1
        if type(value) is int and 0 <= value <= limit:
            result[name] = value
    if type(values.get("matched")) is bool:
        result["matched"] = values["matched"]
    version = values.get("version")
    if isinstance(version, str) and re.fullmatch(r"[0-9]{1,5}(?:\.[0-9]{1,5}){1,3}", version):
        result["version"] = version
    if "error_code" in values:
        result["error_code"] = safe_error_code(values["error_code"])
    return result


class DiagnosticLog:
    def __init__(self, root: Path, *, version: str, component: str = "cli", command: str = "", attempt_id: str | None = None, clock: Callable[[], datetime] | None = None):
        self.root = Path(root).absolute()
        self.version = version
        self.component = component
        self.command = command
        self.attempt_id = diagnostic_id(attempt_id)
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.write_failed = False
        self._warned = False

    @classmethod
    def for_home(cls, home: Path, **kwargs: Any) -> "DiagnosticLog":
        # Production uses one FargoWork-wide diagnostic budget so bootstrap
        # can write before the employee installation ownership marker exists.
        home = Path(home).absolute()
        root = home.parent / "diagnostics" if home.name == "employee" and home.parent.name == "FargoWork" else home / "diagnostics"
        return cls(root, **kwargs)

    def _entries(self) -> tuple[list[tuple[Path, os.stat_result]], int]:
        managed = []
        total = 0
        for path in self.root.iterdir():
            info = _regular(path)
            total += info.st_size
            if FILE_PATTERN.fullmatch(path.name):
                managed.append((path, info))
        return sorted(managed, key=lambda item: item[0].name), total

    def _prune(self, now: datetime, extra: int = 0) -> list[tuple[Path, os.stat_result]]:
        entries, total = self._entries()
        cutoff = (now - timedelta(days=RETENTION_DAYS - 1)).date().isoformat()
        remaining = []
        for path, info in entries:
            match = FILE_PATTERN.fullmatch(path.name)
            if match and (match.group(1) < cutoff or info.st_size > FILE_BYTES):
                _regular(path)
                path.unlink()
                total -= info.st_size
            else:
                remaining.append((path, info))
        while remaining and total + extra > DIRECTORY_BYTES:
            path, info = remaining.pop(0)
            _regular(path)
            path.unlink()
            total -= info.st_size
        if total + extra > DIRECTORY_BYTES:
            raise DiagnosticError("diagnostic budget is unavailable")
        return remaining

    def record(self, event: str, phase: str, **fields: Any) -> bool:
        try:
            now = self.clock().astimezone(timezone.utc)
            payload = _safe_event({"timestamp": now.isoformat(), "component": self.component, "command": self.command, "version": self.version, "attempt_id": self.attempt_id, "pid": os.getpid(), "parent_pid": os.getppid(), **fields, "event": event, "phase": phase})
            raw = (json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8")
            if len(raw) > EVENT_BYTES:
                raise DiagnosticError("diagnostic event is too large")
            with _directory_lock(self.root):
                entries = self._prune(now, len(raw))
                day = now.date().isoformat()
                today = [(path, info) for path, info in entries if FILE_PATTERN.fullmatch(path.name).group(1) == day]
                sequence = int(FILE_PATTERN.fullmatch(today[-1][0].name).group(2)) if today else 1
                if today and today[-1][1].st_size + len(raw) <= FILE_BYTES:
                    path = today[-1][0]
                else:
                    sequence += bool(today)
                    if sequence > 999999:
                        raise DiagnosticError("diagnostic sequence is unavailable")
                    path = self.root / f"diagnostic-{day}-{sequence:06d}.jsonl"
                fd = _open_regular(path, create=True)
                try:
                    os.lseek(fd, 0, os.SEEK_END)
                    written = os.write(fd, raw)
                    if written != len(raw):
                        raise DiagnosticError("diagnostic write was incomplete")
                finally:
                    os.close(fd)
            return True
        except Exception:
            self.write_failed = True
            return False

    def export(self, destination: Path, *, days: int = RETENTION_DAYS) -> dict[str, Any]:
        if type(days) is not int or not 1 <= days <= RETENTION_DAYS:
            raise DiagnosticError("diagnostic export window is invalid")
        destination = Path(destination).absolute()
        if destination.suffix.lower() != ".zip" or destination.exists() or destination.is_symlink():
            raise DiagnosticError("diagnostic export needs a new zip path")
        now = self.clock().astimezone(timezone.utc)
        cutoff = now - timedelta(days=days)
        # A support export may not land in diagnostics or a profile/vault tree.
        normalized_parts = tuple(part.casefold() for part in destination.parts)
        if destination.is_relative_to(self.root) or any(part in {"profiles", "employee"} for part in normalized_parts):
            raise DiagnosticError("diagnostic export destination is reserved")
        _ensure_directory(destination.parent)
        count = 0
        rejected = 0
        created_inode = None
        try:
            with _directory_lock(self.root, timeout=2.0):
                entries = self._prune(now)
                fd = _open_regular(destination, create=True, exclusive=True)
                created_inode = os.fstat(fd)
                with os.fdopen(fd, "wb") as output, zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                    for path, info in entries:
                        if info.st_size > FILE_BYTES:
                            rejected += 1
                            continue
                        input_fd = _open_regular(path)
                        contents = bytearray()
                        with os.fdopen(input_fd, "rb") as input_file:
                            while True:
                                line = input_file.readline(EVENT_BYTES + 1)
                                if not line:
                                    break
                                if len(line) > EVENT_BYTES:
                                    # Drain the rest of this malformed line without
                                    # ever copying an unbounded payload to memory.
                                    while line and not line.endswith(b"\n"):
                                        line = input_file.readline(EVENT_BYTES + 1)
                                    rejected += 1
                                    continue
                                try:
                                    event = _safe_event(json.loads(line))
                                    stamp = _timestamp(event.get("timestamp"))
                                    if not stamp or datetime.fromisoformat(stamp) < cutoff or datetime.fromisoformat(stamp) > now:
                                        continue
                                    safe_line = (json.dumps(event, ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8")
                                    if len(safe_line) > EVENT_BYTES:
                                        raise ValueError
                                    contents.extend(safe_line)
                                    count += 1
                                except (TypeError, ValueError, DiagnosticError, UnicodeDecodeError):
                                    rejected += 1
                        if contents:
                            archive.writestr(path.name, contents)
                    archive.writestr("support-export.json", json.dumps({"schema_version": 1, "created_at": now.isoformat(), "window_days": days, "event_count": count, "rejected_records": rejected, "contains_credentials": False, "contains_profiles": False}, separators=(",", ":")))
            return {"path": str(destination), "event_count": count, "rejected_records": rejected, "window_days": days}
        except Exception as exc:
            # Never remove an arbitrary path; only the regular destination we
            # just created may be removed if its inode still belongs to us.
            if created_inode is not None:
                try:
                    current = _regular(destination)
                    if (current.st_dev, current.st_ino) == (created_inode.st_dev, created_inode.st_ino):
                        destination.unlink()
                except (OSError, DiagnosticError):
                    pass
            raise DiagnosticError("diagnostic export could not be completed") from exc
