"""Small, local-only preferences for an already verified FargoWork employee.

The caller must obtain ``corp_id`` and ``userid`` from a successful server
identity request immediately before each operation. This module does not
authenticate an identity, authorize business actions, or touch credentials.
Preferences are suggestions and never replace workflow validation or consent.
The employee can edit their own ``preferences.md``. Metadata and optional
display settings are separate, and an upgrade never rewrites that document.

Different identities get different hashed filenames. This prevents accidental
mix-ups, not access by another person sharing the same operating-system user.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes
import errno
import hashlib
import json
import os
import re
import secrets
import stat
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping


SCHEMA_VERSION = 1
MAX_PROFILE_BYTES = 64 * 1024
MAX_REVIEWED_VERSIONS = 128
LOCK_TIMEOUT_SECONDS = 5.0
DEFAULT_PREFERENCES = {"language": "zh-CN", "response_style": "concise"}
DEFAULT_MARKDOWN = """# 我的 FargoWork 个人偏好

这是一份可自行编辑的本地文档。仅在核验当前公司身份后使用，不能用于鉴权，
不能覆盖服务端身份、角色、审批规则，也不能跳过最终草稿确认。
AI 只能把这里的内容当作建议；业务选项每次仍应向我确认。
请不要记录密码、token、银行卡、证件号码或其他人的个人信息。

## 表达偏好

填写我希望使用的语言、语气、回复长短等；留空表示没有额外偏好。

## 出差习惯

填写我愿意提供的低风险工作习惯；日期、金额、审批人等由本次申请确定。

## 币种与其他建议

填写我常用的币种或其他合法选项，仅作为提问和建议的参考，不能静默填入申请。
"""
_PREFERENCE_VALUES = {
    "language": frozenset(("zh-CN", "en")),
    "response_style": frozenset(("concise", "balanced", "detailed")),
}
_STATE_KEYS = frozenset((
    "schema_version", "profile_id", "client_version", "reset_prompt_pending",
    "reviewed_client_versions", "preferences", "created_at", "updated_at",
))
_VERSION_PATTERN = re.compile(r"[0-9A-Za-z][0-9A-Za-z._+\-]{0,63}\Z")
_ID_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
_THREAD_LOCKS: dict[str, threading.Lock] = {}
_THREAD_LOCKS_GUARD = threading.Lock()


class ProfileError(RuntimeError):
    """A safe, actionable failure; never include profile contents or identity."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _version(value: Any) -> str:
    if not isinstance(value, str) or not _VERSION_PATTERN.fullmatch(value):
        raise ProfileError("profile_version_invalid", "Use a valid FargoWork client version.")
    return value


def _identity_key(identity: Mapping[str, Any]) -> str:
    if not isinstance(identity, Mapping):
        raise ProfileError("profile_identity_invalid", "Verify the current company identity before opening preferences.")
    identifiers = []
    for key in ("corp_id", "userid"):
        value = identity.get(key)
        if (
            not isinstance(value, str) or not value or len(value) > 256
            or value != value.strip() or any(ord(char) < 32 or ord(char) == 127 for char in value)
        ):
            raise ProfileError("profile_identity_invalid", "Verify the current company identity before opening preferences.")
        identifiers.append(value)
    raw = json.dumps(identifiers, ensure_ascii=True, separators=(",", ":")).encode("ascii")
    return hashlib.sha256(b"fargowork-employee-profile-v1\x00" + raw).hexdigest()


def _preferences(value: Any, *, complete: bool) -> dict[str, str]:
    if not isinstance(value, Mapping) or any(key not in _PREFERENCE_VALUES for key in value):
        raise ProfileError("profile_preferences_invalid", "Only language and response_style preferences are supported.")
    if complete and set(value) != set(_PREFERENCE_VALUES):
        raise ProfileError("profile_data_invalid", "Preferences are damaged; preserve the file and ask for support.")
    result = {}
    for key, item in value.items():
        if not isinstance(item, str) or item not in _PREFERENCE_VALUES[key]:
            raise ProfileError("profile_preferences_invalid", "Use one of the supported preference values.")
        result[key] = item
    return result


def _is_link(info: os.stat_result) -> bool:
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def _check_file(info: os.stat_result) -> None:
    if _is_link(info) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ProfileError("profile_path_unsafe", "Preferences cannot use linked or non-regular files. Choose a normal local data folder.")


def _check_directory_chain(path: Path, *, create: bool) -> None:
    """Reject symlinks and Windows reparse points, including parent folders."""
    for part in (*reversed(path.parents), path):
        try:
            info = part.lstat()
        except FileNotFoundError:
            if not create:
                raise ProfileError("profile_storage_unavailable", "The preferences folder is unavailable. Check its location and permissions.") from None
            try:
                part.mkdir(mode=0o700)
            except FileExistsError:
                pass
            info = part.lstat()
        if _is_link(info) or not stat.S_ISDIR(info.st_mode):
            raise ProfileError("profile_path_unsafe", "Preferences cannot use linked folders. Choose a normal local data folder.")


def _open_file(path: Path, flags: int) -> int:
    """Open the final component without following POSIX or Windows links."""
    _check_directory_chain(path.parent, create=False)
    try:
        _check_file(path.lstat())
    except FileNotFoundError:
        pass
    if os.name == "nt":
        import msvcrt

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        create_file = kernel.CreateFileW
        create_file.argtypes = (
            ctypes.wintypes.LPCWSTR, ctypes.wintypes.DWORD, ctypes.wintypes.DWORD,
            ctypes.wintypes.LPVOID, ctypes.wintypes.DWORD, ctypes.wintypes.DWORD,
            ctypes.wintypes.HANDLE,
        )
        create_file.restype = ctypes.wintypes.HANDLE
        writable = bool(flags & (os.O_WRONLY | os.O_RDWR))
        access = 0x80000000 if not (flags & os.O_WRONLY) else 0
        if writable:
            access |= 0x40000000
        disposition = 1 if flags & os.O_EXCL else (4 if flags & os.O_CREAT else 3)
        # FILE_FLAG_OPEN_REPARSE_POINT opens a link itself, never its target.
        handle = create_file(str(path), access, 7, None, disposition, 0x00200080, None)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            descriptor = msvcrt.open_osfhandle(handle, (flags & (os.O_WRONLY | os.O_RDWR)) | os.O_BINARY)
        except BaseException:
            close_handle = kernel.CloseHandle
            close_handle.argtypes = (ctypes.wintypes.HANDLE,)
            close_handle(handle)
            raise
    else:
        descriptor = os.open(path, flags | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0), 0o600)
    try:
        opened = os.fstat(descriptor)
        _check_file(opened)
        current = path.lstat()
        _check_file(current)
        _check_directory_chain(path.parent, create=False)
        if (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
            raise ProfileError("profile_path_unsafe", "The preferences file changed during access. Retry after checking the data folder.")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


@contextmanager
def _profile_lock(path: Path):
    key = os.path.normcase(str(path))
    with _THREAD_LOCKS_GUARD:
        thread_lock = _THREAD_LOCKS.setdefault(key, threading.Lock())
    if not thread_lock.acquire(timeout=LOCK_TIMEOUT_SECONDS):
        raise ProfileError("profile_busy", "Preferences are in use. Wait briefly and retry.")
    descriptor = None
    locked = False
    try:
        descriptor = _open_file(path, os.O_RDWR | os.O_CREAT)
        size = os.fstat(descriptor).st_size
        if size == 0:
            os.write(descriptor, b"\x00")
        elif size != 1:
            raise ProfileError("profile_data_invalid", "The preferences lock file is damaged. Preserve it and ask for support.")
        deadline = time.monotonic() + LOCK_TIMEOUT_SECONDS
        while True:
            try:
                if os.name == "nt":
                    import msvcrt

                    os.lseek(descriptor, 0, os.SEEK_SET)
                    msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
                break
            except OSError as exc:
                if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    raise
                if time.monotonic() >= deadline:
                    raise ProfileError("profile_busy", "Preferences are in use. Wait briefly and retry.") from None
                time.sleep(0.05)
        yield
    finally:
        try:
            if descriptor is not None:
                try:
                    if locked:
                        if os.name == "nt":
                            import msvcrt

                            os.lseek(descriptor, 0, os.SEEK_SET)
                            msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
                        else:
                            import fcntl

                            fcntl.flock(descriptor, fcntl.LOCK_UN)
                finally:
                    os.close(descriptor)
        finally:
            thread_lock.release()


def _json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def _timestamp(value: Any) -> bool:
    if not isinstance(value, str) or len(value) > 40 or not value.endswith("Z"):
        return False
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is not None
    except ValueError:
        return False


class ProfileStore:
    """A bounded preference store; callers supply a freshly verified identity."""

    def __init__(self, home: str | os.PathLike[str], client_version: str):
        try:
            location = os.fspath(home)
        except TypeError:
            raise ProfileError("profile_path_invalid", "Choose a valid local FargoWork data folder.") from None
        if not isinstance(location, str) or not location.strip() or "\x00" in location:
            raise ProfileError("profile_path_invalid", "Choose a valid local FargoWork data folder.")
        self.home = Path(os.path.abspath(location))
        self.client_version = _version(client_version)
        self.directory = self.home / "profiles"

    def _read(self, path: Path, profile_id: str) -> dict[str, Any] | None:
        try:
            descriptor = _open_file(path, os.O_RDONLY)
        except FileNotFoundError:
            return None
        try:
            if os.fstat(descriptor).st_size > MAX_PROFILE_BYTES:
                raise ProfileError("profile_data_invalid", "Preferences exceed the size limit. Preserve the file and ask for support.")
            with os.fdopen(descriptor, "rb") as source:
                descriptor = None
                raw = source.read(MAX_PROFILE_BYTES + 1)
            if len(raw) > MAX_PROFILE_BYTES:
                raise ValueError("size limit")
            state = json.loads(raw.decode("utf-8"), object_pairs_hook=_json_object)
            if not isinstance(state, dict) or set(state) != _STATE_KEYS:
                raise ValueError("schema fields")
            if type(state["schema_version"]) is not int or state["schema_version"] != SCHEMA_VERSION:
                raise ProfileError("profile_schema_unsupported", "This profile schema is unsupported. Preserve the file and use a compatible client.")
            if state["profile_id"] != profile_id or not _ID_PATTERN.fullmatch(str(state["profile_id"])):
                raise ProfileError("profile_identity_mismatch", "Preferences do not belong to the verified account. Preserve the file and ask for support.")
            try:
                _version(state["client_version"])
            except ProfileError:
                raise ValueError("client version") from None
            if type(state["reset_prompt_pending"]) is not bool:
                raise ValueError("reset flag")
            reviewed = state["reviewed_client_versions"]
            if not isinstance(reviewed, list) or not 1 <= len(reviewed) <= MAX_REVIEWED_VERSIONS:
                raise ValueError("reviewed versions")
            try:
                if len(set(_version(item) for item in reviewed)) != len(reviewed):
                    raise ValueError("duplicate version")
            except ProfileError:
                raise ValueError("reviewed version") from None
            if state["reset_prompt_pending"] != (state["client_version"] not in reviewed):
                raise ValueError("review flag")
            if not _timestamp(state["created_at"]) or not _timestamp(state["updated_at"]):
                raise ValueError("timestamp")
            try:
                state["preferences"] = _preferences(state["preferences"], complete=True)
            except ProfileError:
                raise ValueError("stored preferences") from None
            return state
        except ProfileError:
            raise
        except (UnicodeError, ValueError, TypeError, RecursionError):
            raise ProfileError("profile_data_invalid", "Preferences are damaged. Preserve the file and ask for support.") from None
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def _read_markdown(self, path: Path) -> bool:
        """Validate the selected document without exposing its contents."""
        try:
            descriptor = _open_file(path, os.O_RDONLY)
        except FileNotFoundError:
            return False
        try:
            if os.fstat(descriptor).st_size > MAX_PROFILE_BYTES:
                raise ValueError("size limit")
            with os.fdopen(descriptor, "rb") as source:
                descriptor = None
                raw = source.read(MAX_PROFILE_BYTES + 1)
            if len(raw) > MAX_PROFILE_BYTES or b"\x00" in raw:
                raise ValueError("document invalid")
            raw.decode("utf-8-sig")
            return True
        except (ValueError, UnicodeError):
            raise ProfileError("profile_document_invalid", "The preferences document must be UTF-8 text no larger than 64 KiB. Preserve it and ask for support.") from None
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def _write_raw(self, path: Path, raw: bytes, *, replace: bool = True) -> None:
        if len(raw) > MAX_PROFILE_BYTES:
            raise ProfileError("profile_data_invalid", "Preferences exceed the size limit. Preserve the file and ask for support.")
        temporary = path.parent / f".{path.name}.{secrets.token_hex(12)}.tmp"
        descriptor = _open_file(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        temporary_identity = os.fstat(descriptor)
        try:
            with os.fdopen(descriptor, "wb") as output:
                descriptor = None
                output.write(raw)
                output.flush()
                os.fsync(output.fileno())
            _check_directory_chain(path.parent, create=False)
            try:
                _check_file(path.lstat())
                if not replace:
                    raise ProfileError("profile_incomplete", "Preferences already exist without valid metadata. Preserve the files and ask for support.")
            except FileNotFoundError:
                pass
            os.replace(temporary, path)
        finally:
            if descriptor is not None:
                os.close(descriptor)
            # Clean only this operation's own regular temporary file.
            try:
                _check_directory_chain(temporary.parent, create=False)
                info = temporary.lstat()
                if not _is_link(info) and stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and (info.st_dev, info.st_ino) == (temporary_identity.st_dev, temporary_identity.st_ino):
                    temporary.unlink()
            except FileNotFoundError:
                pass

    def _write(self, path: Path, state: dict[str, Any]) -> None:
        raw = (json.dumps(state, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
        self._write_raw(path, raw)

    def _operate(self, identity: Mapping[str, Any], operation, *, force_write: bool = False, reset_markdown: bool = False) -> dict[str, Any]:
        profile_id = _identity_key(identity)
        try:
            _check_directory_chain(self.directory, create=True)
            with _profile_lock(self.directory / f"{profile_id}.lock"):
                profile_directory = self.directory / profile_id
                _check_directory_chain(profile_directory, create=True)
                path = profile_directory / "metadata.json"
                markdown = profile_directory / "preferences.md"
                state = self._read(path, profile_id)
                markdown_exists = self._read_markdown(markdown)
                if (state is None) != (not markdown_exists):
                    raise ProfileError("profile_incomplete", "The preferences document and metadata are incomplete. Preserve the files and ask for support.")
                changed = state is None
                if state is None:
                    timestamp = _now()
                    state = {
                        "schema_version": SCHEMA_VERSION, "profile_id": profile_id,
                        "client_version": self.client_version, "reset_prompt_pending": False,
                        "reviewed_client_versions": [self.client_version],
                        "preferences": dict(DEFAULT_PREFERENCES),
                        "created_at": timestamp, "updated_at": timestamp,
                    }
                elif state["client_version"] != self.client_version:
                    state["client_version"] = self.client_version
                    state["reset_prompt_pending"] = self.client_version not in state["reviewed_client_versions"]
                    changed = True
                operation(state)
                if not markdown_exists or reset_markdown:
                    self._write_raw(markdown, DEFAULT_MARKDOWN.encode("utf-8"), replace=markdown_exists)
                if changed or force_write:
                    state["updated_at"] = _now()
                    self._write(path, state)
                result = {key: (dict(value) if key == "preferences" else value) for key, value in state.items() if key != "reviewed_client_versions"}
                result["markdown_path"] = str(markdown)
                return result
        except ProfileError:
            raise
        except OSError:
            raise ProfileError("profile_storage_unavailable", "Preferences could not be saved or read. Check the local folder permissions and available space.") from None

    def open_for_verified_identity(self, identity: Mapping[str, Any]) -> dict[str, Any]:
        """Create a template if absent; upgrades preserve preferences and ask once."""
        return self._operate(identity, lambda state: None)

    def decide_reset(self, identity: Mapping[str, Any], reset: bool) -> dict[str, Any]:
        """Record the employee's explicit keep/reset choice for this version."""
        if type(reset) is not bool:
            raise ProfileError("profile_reset_invalid", "Choose explicitly whether to keep or reset preferences.")

        def decide(state):
            reviewed = state["reviewed_client_versions"]
            if self.client_version not in reviewed:
                if len(reviewed) >= MAX_REVIEWED_VERSIONS:
                    raise ProfileError("profile_history_limit", "The profile version history is full. Preserve the file and ask for support.")
                reviewed.append(self.client_version)
            if reset:
                state["preferences"] = dict(DEFAULT_PREFERENCES)
            state["reset_prompt_pending"] = False

        return self._operate(identity, decide, force_write=True, reset_markdown=reset)

    def update_preferences(self, identity: Mapping[str, Any], prefs: Mapping[str, Any]) -> dict[str, Any]:
        """Patch only supported display preferences; do not accept arbitrary data."""
        validated = _preferences(prefs, complete=False)
        return self._operate(identity, lambda state: state["preferences"].update(validated), force_write=bool(validated))
