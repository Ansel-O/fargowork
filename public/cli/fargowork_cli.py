"""FargoWork employee business CLI with managed OAuth and MCP HTTP upstream."""

from __future__ import annotations

import argparse
import base64
import binascii
import ctypes
import ctypes.wintypes
import errno
import hashlib
import hmac
import http.client
import ipaddress
import json
import os
import platform
import re
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping
from urllib.parse import urlsplit

# The CLI is also imported by the public source tests with importlib.  Keep
# these two stdlib-only client modules discoverable in that execution mode.
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
from client_diagnostics import DiagnosticError, DiagnosticLog, EVENTS, PHASES, OUTCOMES, diagnostic_id, safe_error_code
from employee_profile import ProfileError, ProfileStore
import employee_attachments


VERSION = "1.4.0"
MCP_PROTOCOL_VERSION = "2026-07-28"
AGENT_PLUGINS_SPEC_VERSION = "1.0.0"
ACTION_RESULT_CONTRACT_VERSION = 1
MCP_SCOPE = "fargowork:mcp"
CLIENT_ENVIRONMENT = "employee"
DEFAULT_ISSUER = ""
DEFAULT_RESOURCE = ""
DEFAULT_RESOURCE_METADATA_URI = ""
DEFAULT_CLIENT_ID = "fargowork-cli"
DEFAULT_REDIRECT_URI = "http://127.0.0.1:37680/oauth/callback"
PLUGIN_NAME = "fargowork-employee"
MARKER = "fargowork-owned-v1"

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_NEEDS_ACTION = 3
EXIT_UNAVAILABLE = 4
EXIT_SECURE_STORAGE = 5
EXIT_PROTOCOL = 6


class FargoWorkError(RuntimeError):
    """An expected, user-actionable CLI failure."""

    def __init__(self, message: str, *, code: str = "error", exit_code: int = EXIT_UNAVAILABLE):
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


class AuthRequired(FargoWorkError):
    def __init__(self, message: str = "FargoWork login is required"):
        super().__init__(message, code="auth_required", exit_code=EXIT_NEEDS_ACTION)


class VaultError(FargoWorkError):
    def __init__(self, message: str):
        super().__init__(message, code="secure_storage_unavailable", exit_code=EXIT_SECURE_STORAGE)


_REFRESH_LOCKS: dict[str, threading.Lock] = {}
_REFRESH_LOCKS_GUARD = threading.Lock()
_DIAGNOSTIC_CONTEXT: ContextVar[DiagnosticLog | None] = ContextVar("fargowork_client_diagnostics", default=None)


def _diagnostic_record(log: DiagnosticLog | None, event: str, phase: str, **fields: Any) -> None:
    if log is None:
        return
    try:
        written = log.record(event, phase, **fields)
    except Exception:
        log.write_failed = True
        written = False
    if not written:
        log.write_failed = True
    if not written and not log._warned:
        log._warned = True
        # Keep diagnostics out of structured business output and never make
        # a successful business action fail because logging is unavailable.
        try:
            print("FargoWork: diagnostic_write_failed", file=sys.stderr, flush=True)
        except (OSError, ValueError):
            pass


def _current_profile(config: "Config", identity: Mapping[str, Any]) -> dict[str, Any]:
    """Called only with a principal returned by a successful Server me call."""
    try:
        profile = ProfileStore(config.home, VERSION).open_for_verified_identity(identity)
        _diagnostic_record(_DIAGNOSTIC_CONTEXT.get(), "profile_result", "profile", outcome="succeeded")
        return {"status": "ready", **profile}
    except (ProfileError, OSError, ValueError) as exc:
        _diagnostic_record(_DIAGNOSTIC_CONTEXT.get(), "profile_result", "profile", outcome="failed", error_code=getattr(exc, "code", "profile_unavailable"))
        return {"status": "unavailable", "error_code": getattr(exc, "code", "profile_unavailable")}


@contextmanager
def _vault_refresh_lock(path: Path):
    """Serialize refresh-token rotation across threads and local processes."""
    lock_path = path.resolve()
    lock_key = os.path.normcase(str(lock_path))
    with _REFRESH_LOCKS_GUARD:
        thread_lock = _REFRESH_LOCKS.setdefault(lock_key, threading.Lock())
    thread_lock.acquire()
    fd: int | None = None
    file_locked = False
    try:
        try:
            lock_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_BINARY", 0)
            if hasattr(os, "O_CLOEXEC"):
                flags |= os.O_CLOEXEC
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            fd = os.open(str(lock_path), flags, 0o600)
            if os.fstat(fd).st_size == 0:
                os.lseek(fd, 0, os.SEEK_SET)
                os.write(fd, b"\0")
            if os.name == "nt":
                import msvcrt

                while True:
                    os.lseek(fd, 0, os.SEEK_SET)
                    try:
                        msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
                        break
                    except OSError as exc:
                        if exc.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                            raise
                        time.sleep(0.05)
            else:
                import fcntl

                fcntl.flock(fd, fcntl.LOCK_EX)
            file_locked = True
        except OSError as exc:
            raise VaultError("refresh-token vault lock could not be acquired") from exc
        yield
    finally:
        try:
            if fd is not None:
                if file_locked:
                    try:
                        if os.name == "nt":
                            import msvcrt

                            os.lseek(fd, 0, os.SEEK_SET)
                            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                        else:
                            import fcntl

                            fcntl.flock(fd, fcntl.LOCK_UN)
                    except OSError:
                        # Closing the descriptor also releases the OS lock.
                        pass
                os.close(fd)
        finally:
            thread_lock.release()


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def _atomic_write(path: Path, data: bytes, *, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    temp_path = Path(temp_name)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(fd, mode)
        else:
            os.chmod(temp_path, mode)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    except Exception:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def _safe_no_secret(value: Any) -> Any:
    """Return a recursively redacted structure for logs/status payloads."""
    secret_words = {
        "token",
        "access_token",
        "refresh_token",
        "secret",
        "client_secret",
        "authorization",
        "cookie",
        "code",
        "code_verifier",
        "private_key",
    }
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            lowered = str(key).lower()
            if lowered in secret_words:
                continue
            result[str(key)] = _safe_no_secret(item)
        return result
    if isinstance(value, list):
        return [_safe_no_secret(item) for item in value]
    return value


def _config_base_home() -> Path:
    override = os.environ.get("FARGOWORK_HOME") if CLIENT_ENVIRONMENT == "development" else None
    if override:
        return Path(override).expanduser().resolve()
    system = platform.system()
    if system == "Windows":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / "FargoWork"
    if system == "Darwin":
        return Path.home() / "Library" / "Application Support" / "FargoWork"
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "fargowork"


def _config_home() -> Path:
    base = _config_base_home()
    if CLIENT_ENVIRONMENT == "employee":
        return base / "employee"
    return base


def _plugin_home() -> Path:
    if CLIENT_ENVIRONMENT == "development":
        override = os.environ.get("FARGOWORK_PLUGIN_DIR")
        if override:
            return Path(override).expanduser().resolve()
    return (_config_home() / "plugin" / PLUGIN_NAME).resolve()


def _codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser().resolve()


def _validate_endpoint(name: str, value: str, *, allow_loopback_http: bool = True) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise FargoWorkError(f"{name} must be an absolute HTTP(S) URL without credentials or fragments", code="invalid_config", exit_code=EXIT_USAGE)
    if parsed.query:
        raise FargoWorkError(f"{name} must not contain a query", code="invalid_config", exit_code=EXIT_USAGE)
    if parsed.scheme == "http":
        try:
            address = ipaddress.ip_address(parsed.hostname)
            loopback = address.is_loopback
        except ValueError:
            loopback = parsed.hostname.lower() == "localhost"
        if not allow_loopback_http or not loopback:
            raise FargoWorkError(f"{name} HTTP endpoint must be loopback", code="invalid_config", exit_code=EXIT_USAGE)
    return value.rstrip("/")


def _validate_issuer(value: str) -> str:
    issuer = _validate_endpoint("issuer", value)
    if urlsplit(issuer).path not in {"", "/"}:
        raise FargoWorkError("issuer must be the service origin without a path", code="invalid_config", exit_code=EXIT_USAGE)
    return issuer


def _validate_attachments_issuer(value: str | None) -> str:
    """Validate the optional, operator-configured attachment authorization origin."""
    if value is None or value == "":
        return ""
    message = "attachments_issuer must be an HTTPS origin or a loopback HTTP origin without credentials, query or fragment"
    if (not isinstance(value, str) or len(value) > 2048
            or any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in value)
            or any(character in value for character in ("\\", "?", "#"))):
        raise FargoWorkError(message, code="invalid_config", exit_code=EXIT_USAGE)
    try:
        parsed = urlsplit(value)
        port = parsed.port
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.path not in {"", "/"} or parsed.query or parsed.fragment
                or parsed.netloc.endswith(":") or port is not None and port < 1
                or "%" in parsed.hostname):
            raise ValueError
        if parsed.scheme == "http":
            try:
                loopback = ipaddress.ip_address(parsed.hostname).is_loopback
            except ValueError:
                loopback = parsed.hostname.lower() == "localhost"
            if not loopback:
                raise ValueError
    except ValueError as exc:
        raise FargoWorkError(message, code="invalid_config", exit_code=EXIT_USAGE) from exc
    return value.rstrip("/")


def _validate_redirect(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise FargoWorkError("redirect_uri must be an absolute URL without credentials or fragments", code="invalid_config", exit_code=EXIT_USAGE)
    try:
        port = parsed.port
    except ValueError as exc:
        raise FargoWorkError("redirect_uri must contain a valid port", code="invalid_config", exit_code=EXIT_USAGE) from exc
    if parsed.scheme == "http":
        if parsed.hostname not in {"127.0.0.1", "::1"} or port is None:
            raise FargoWorkError("HTTP redirect_uri must use fixed-port 127.0.0.1 or ::1", code="invalid_config", exit_code=EXIT_USAGE)
    return value


@dataclass
class Config:
    home: Path = field(default_factory=_config_home)
    issuer: str = DEFAULT_ISSUER
    resource: str = DEFAULT_RESOURCE
    resource_metadata_uri: str = DEFAULT_RESOURCE_METADATA_URI
    client_id: str = DEFAULT_CLIENT_ID
    redirect_uri: str = DEFAULT_REDIRECT_URI
    scope: str = MCP_SCOPE
    plugin_dir: Path = field(default_factory=_plugin_home)
    version: str = VERSION
    environment: str = CLIENT_ENVIRONMENT
    codex_path: str = ""
    attachments_url: str = employee_attachments.DEFAULT_SERVICE
    attachments_issuer: str = ""

    def __post_init__(self) -> None:
        self.attachments_issuer = _validate_attachments_issuer(self.attachments_issuer)

    @property
    def effective_attachments_issuer(self) -> str:
        return _validate_attachments_issuer(self.attachments_issuer) or self.issuer

    @property
    def credential_fingerprint(self) -> str:
        identity = {
            "environment": self.environment,
            "issuer": self.issuer,
            "resource": self.resource,
            "resource_metadata_uri": self.resource_metadata_uri,
            "client_id": self.client_id,
        }
        return hashlib.sha256(_json_bytes(identity)).hexdigest()[:24]

    def secure_vault(self) -> "SecureVault":
        return SecureVault(
            self.home,
            environment=self.environment,
            issuer=self.issuer,
            resource=self.resource,
            resource_metadata_uri=self.resource_metadata_uri,
            client_id=self.client_id,
        )

    @classmethod
    def load(cls) -> "Config":
        home = _config_home()
        values: dict[str, Any] = {}
        path = home / "config.json"
        if path.exists():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(loaded, dict):
                    raise ValueError
                values.update(loaded)
            except (OSError, ValueError, json.JSONDecodeError) as exc:
                raise FargoWorkError("FargoWork configuration is unreadable", code="invalid_config", exit_code=EXIT_USAGE) from exc
        if CLIENT_ENVIRONMENT == "development":
            values.update({key: env for key, env in {
                "issuer": os.environ.get("FARGOWORK_ISSUER"),
                "resource": os.environ.get("FARGOWORK_RESOURCE"),
                "resource_metadata_uri": os.environ.get("FARGOWORK_RESOURCE_METADATA_URI"),
                "client_id": os.environ.get("FARGOWORK_CLIENT_ID"),
                "redirect_uri": os.environ.get("FARGOWORK_REDIRECT_URI"),
                "plugin_dir": os.environ.get("FARGOWORK_PLUGIN_DIR"),
            }.items() if env})
        configured_environment = str(values.get("environment", CLIENT_ENVIRONMENT))
        if configured_environment != CLIENT_ENVIRONMENT:
            raise FargoWorkError("configuration belongs to a different FargoWork environment", code="invalid_config", exit_code=EXIT_USAGE)
        issuer_value = str(values.get("issuer", DEFAULT_ISSUER)).strip()
        if issuer_value:
            issuer_value = _validate_issuer(issuer_value)
            expected_resource = f"{issuer_value}/mcp"
            expected_metadata = f"{issuer_value}/.well-known/oauth-protected-resource"
            resource_value = str(values.get("resource", expected_resource)).strip() or expected_resource
            metadata_value = str(values.get("resource_metadata_uri", expected_metadata)).strip() or expected_metadata
            if resource_value != expected_resource or metadata_value != expected_metadata:
                raise FargoWorkError("resource and metadata endpoints must be derived from the configured issuer", code="invalid_config", exit_code=EXIT_USAGE)
        else:
            resource_value = ""
            metadata_value = ""
        redirect_value = str(values.get("redirect_uri", DEFAULT_REDIRECT_URI))
        if redirect_value != DEFAULT_REDIRECT_URI:
            raise FargoWorkError("redirect_uri must use the fixed FargoWork loopback callback", code="invalid_config", exit_code=EXIT_USAGE)
        config = cls(
            home=home,
            issuer=issuer_value,
            resource=_validate_endpoint("resource", resource_value) if resource_value else "",
            resource_metadata_uri=_validate_endpoint("resource_metadata_uri", metadata_value) if metadata_value else "",
            client_id=str(values.get("client_id", DEFAULT_CLIENT_ID)),
            redirect_uri=_validate_redirect(redirect_value),
            scope=MCP_SCOPE,
            plugin_dir=Path(str(values.get("plugin_dir", _plugin_home()))).expanduser().resolve() if CLIENT_ENVIRONMENT == "development" else _plugin_home(),
            version=str(values.get("version", VERSION)),
            environment=CLIENT_ENVIRONMENT,
            codex_path=str(values.get("codex_path") or ""),
            attachments_url=str(values.get("attachments_url") or employee_attachments.DEFAULT_SERVICE),
            attachments_issuer=_validate_attachments_issuer(values.get("attachments_issuer", "")),
        )
        if not config.client_id or any(char.isspace() for char in config.client_id):
            raise FargoWorkError("client_id is invalid", code="invalid_config", exit_code=EXIT_USAGE)
        return config

    def save(self) -> None:
        attachments_issuer = _validate_attachments_issuer(self.attachments_issuer)
        self.home.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema_version": 1,
            "issuer": self.issuer,
            "resource": self.resource,
            "resource_metadata_uri": self.resource_metadata_uri,
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "scope": self.scope,
            "plugin_dir": str(self.plugin_dir),
            "version": self.version,
            "environment": self.environment,
            "codex_path": self.codex_path,
            "attachments_url": self.attachments_url,
            "attachments_issuer": attachments_issuer,
        }
        _atomic_write(self.home / "config.json", _json_bytes(payload))


class SecureVault:
    """OS-backed refresh-token storage; no plaintext fallback is allowed."""

    legacy_service = "fargowork.refresh-token.v1"
    linux_account = "default"

    def __init__(
        self,
        home: Path | None = None,
        *,
        environment: str = CLIENT_ENVIRONMENT,
        issuer: str = "",
        resource: str = "",
        resource_metadata_uri: str = "",
        client_id: str = DEFAULT_CLIENT_ID,
    ):
        self.home = home or _config_home()
        self.environment = environment
        fingerprint = hashlib.sha256(_json_bytes({
            "environment": environment,
            "issuer": issuer,
            "resource": resource,
            "resource_metadata_uri": resource_metadata_uri,
            "client_id": client_id,
        })).hexdigest()[:24]
        self.namespace = fingerprint
        self.service = f"{self.legacy_service}.{environment}.{fingerprint}"
        self.vault_filename = f"vault.{environment}.{fingerprint}.dpapi"
        self.lock_filename = f"refresh-token.{environment}.{fingerprint}.lock"
        self._memory: str | None = None

    def refresh_lock(self):
        """Return the lock for the credential slot used by this OS vault."""
        if platform.system() == "Linux":
            return _vault_refresh_lock(self._linux_refresh_lock_path())
        return _vault_refresh_lock(self.home / self.lock_filename)

    def _linux_refresh_lock_path(self) -> Path:
        """Use one OS-user lock for the shared Linux Secret Service item."""
        try:
            import pwd

            passwd_entry = pwd.getpwuid(os.getuid())
            os_home = Path(passwd_entry.pw_dir)
        except (AttributeError, ImportError, KeyError, OSError) as exc:
            raise VaultError("Linux OS account home for the refresh-token lock is unavailable") from exc
        if not os_home.is_absolute():
            raise VaultError("Linux OS account home for the refresh-token lock is not absolute")

        slot_parts = (self.service, self.linux_account)
        if not all(
            part and all(character.isalnum() or character in "._-" for character in part)
            for part in slot_parts
        ):
            raise VaultError("Linux Secret Service refresh-token slot has an invalid identifier")
        slot_name = ".".join(slot_parts)
        return os_home / ".local" / "state" / "fargowork" / f"{slot_name}.lock"

    def get(self) -> str | None:
        if platform.system() == "Windows":
            path = self.home / self.vault_filename
            if not path.exists():
                return None
            try:
                return _dpapi_unprotect(path.read_bytes()).decode("utf-8")
            except Exception as exc:
                raise VaultError("Windows DPAPI refresh-token store could not be read") from exc
        if platform.system() == "Darwin":
            return self._mac_get()
        if platform.system() == "Linux":
            return self._linux_get()
        raise VaultError("this platform has no supported secure credential store")

    def set(self, token: str) -> None:
        if not token or any(char.isspace() for char in token):
            raise VaultError("refusing to store an invalid refresh token")
        if platform.system() == "Windows":
            try:
                _atomic_write(self.home / self.vault_filename, _dpapi_protect(token.encode("utf-8")))
                return
            except Exception as exc:
                raise VaultError("Windows DPAPI refresh-token store could not be updated") from exc
        if platform.system() == "Darwin":
            self._mac_set(token)
            return
        if platform.system() == "Linux":
            self._linux_set(token)
            return
        raise VaultError("this platform has no supported secure credential store")

    def delete(self) -> None:
        if platform.system() == "Windows":
            try:
                (self.home / self.vault_filename).unlink(missing_ok=True)
                return
            except OSError as exc:
                raise VaultError("Windows DPAPI refresh-token store could not be cleared") from exc
        if platform.system() == "Darwin":
            self._mac_delete()
            return
        if platform.system() == "Linux":
            self._linux_delete()
            return
        raise VaultError("this platform has no supported secure credential store")

    def _run_secret_tool(self, args: list[str], *, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
        if shutil.which("secret-tool") is None:
            raise VaultError("Linux Secret Service is unavailable; refusing plaintext refresh-token storage")
        return subprocess.run(["secret-tool", *args], input=input_text, text=True, capture_output=True, check=False)

    def _linux_get(self) -> str | None:
        result = self._run_secret_tool(["lookup", "service", self.service, "account", self.linux_account])
        if result.returncode == 1:
            return None
        if result.returncode != 0 or not result.stdout.strip():
            raise VaultError("Linux Secret Service lookup failed")
        return result.stdout.strip()

    def _linux_set(self, token: str) -> None:
        result = self._run_secret_tool(["store", "--label", "FargoWork refresh token", "service", self.service, "account", self.linux_account], input_text=token + "\n")
        if result.returncode != 0:
            raise VaultError("Linux Secret Service refused the refresh token")

    def _linux_delete(self) -> None:
        result = self._run_secret_tool(["clear", "service", self.service, "account", self.linux_account])
        if result.returncode not in {0, 1}:
            raise VaultError("Linux Secret Service could not clear the refresh token")

    def _mac_get(self) -> str | None:
        raise VaultError("macOS native Keychain storage is not enabled in this release; macOS support is unavailable")

    def _mac_set(self, token: str) -> None:
        del token
        raise VaultError("macOS native Keychain storage is not enabled in this release; macOS support is unavailable")

    def _mac_delete(self) -> None:
        raise VaultError("macOS native Keychain storage is not enabled in this release; macOS support is unavailable")


class MemoryVault:
    """Deterministic vault double for unit and fixture tests."""

    def __init__(self, token: str | None = None):
        self.token = token

    def get(self) -> str | None:
        return self.token

    def set(self, token: str) -> None:
        self.token = token

    def delete(self) -> None:
        self.token = None


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Reject HTTP redirects so credential-bearing JSON requests stay on-origin."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _dpapi_protect(data: bytes) -> bytes:
    if platform.system() != "Windows":
        raise OSError("DPAPI is Windows-only")
    crypt32 = ctypes.windll.crypt32
    class Blob(ctypes.Structure):
        _fields_ = [("cbData", ctypes.wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]
    source = ctypes.create_string_buffer(data)
    in_blob = Blob(len(data), ctypes.cast(source, ctypes.POINTER(ctypes.c_byte)))
    out_blob = Blob()
    if not crypt32.CryptProtectData(ctypes.byref(in_blob), "FargoWork refresh token", None, None, None, 0, ctypes.byref(out_blob)):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(out_blob.pbData, out_blob.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(out_blob.pbData)


def _dpapi_unprotect(data: bytes) -> bytes:
    if platform.system() != "Windows":
        raise OSError("DPAPI is Windows-only")
    crypt32 = ctypes.windll.crypt32
    class Blob(ctypes.Structure):
        _fields_ = [("cbData", ctypes.wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]
    source = ctypes.create_string_buffer(data)
    in_blob = Blob(len(data), ctypes.cast(source, ctypes.POINTER(ctypes.c_byte)))
    out_blob = Blob()
    if not crypt32.CryptUnprotectData(ctypes.byref(in_blob), None, None, None, None, 0, ctypes.byref(out_blob)):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(out_blob.pbData, out_blob.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(out_blob.pbData)


@dataclass
class TokenSession:
    config: Config
    vault: Any | None = None
    access_token: str | None = None
    access_expires_at: float = 0.0
    diagnostics: DiagnosticLog | None = None

    def __post_init__(self) -> None:
        if self.vault is None:
            self.vault = self.config.secure_vault()
        if self.diagnostics is None:
            self.diagnostics = _DIAGNOSTIC_CONTEXT.get() or DiagnosticLog.for_home(self.config.home, version=VERSION)

    def _request_json(self, method: str, url: str, *, data: Mapping[str, str] | None = None, headers: Mapping[str, str] | None = None, timeout: float = 15.0) -> tuple[int, dict[str, Any]]:
        request_id = diagnostic_id()
        phase = "token" if urlsplit(url).path == "/oauth/token" else "identity" if urlsplit(url).path == "/auth/me" else "login"
        started = time.monotonic()
        encoded = urllib.parse.urlencode(data or {}).encode("utf-8") if data is not None else None
        request = urllib.request.Request(url, data=encoded, method=method.upper())
        request.add_header("X-Trace-ID", request_id)
        request.add_header("X-FargoWork-Attempt-ID", self.diagnostics.attempt_id)
        if phase == "token":
            _diagnostic_record(self.diagnostics, "token_request_started", phase, request_id=request_id, outcome="started")
        if data is not None:
            request.add_header("Content-Type", "application/x-www-form-urlencoded")
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            opener = urllib.request.build_opener(_NoRedirectHandler())
            with opener.open(request, timeout=timeout) as response:
                body = response.read()
                status = int(response.status)
                server_trace = response.headers.get("X-Trace-ID", "")
        except urllib.error.HTTPError as exc:
            if 300 <= int(exc.code) < 400:
                _diagnostic_record(self.diagnostics, "http_request_result", phase, request_id=request_id, http_status=int(exc.code), outcome="rejected", error_code="endpoint_redirect_rejected", duration_ms=int((time.monotonic() - started) * 1000))
                raise FargoWorkError(
                    "FargoWork endpoint redirected; credential forwarding was refused",
                    code="endpoint_redirect_rejected",
                    exit_code=EXIT_UNAVAILABLE,
                ) from exc
            body = exc.read()
            status = int(exc.code)
            server_trace = exc.headers.get("X-Trace-ID", "")
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            _diagnostic_record(self.diagnostics, "http_request_result", phase, request_id=request_id, outcome="unavailable", error_code="endpoint_unavailable", duration_ms=int((time.monotonic() - started) * 1000))
            raise FargoWorkError(f"FargoWork endpoint is unavailable: {urlsplit(url).netloc}", code="endpoint_unavailable", exit_code=EXIT_UNAVAILABLE) from exc
        _diagnostic_record(self.diagnostics, "token_request_result" if phase == "token" else "http_request_result", phase, request_id=request_id, server_trace_id=server_trace, http_status=status, duration_ms=int((time.monotonic() - started) * 1000), outcome="succeeded" if status < 400 else "failed")
        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise FargoWorkError("FargoWork endpoint returned invalid JSON", code="invalid_response", exit_code=EXIT_UNAVAILABLE) from exc
        if not isinstance(payload, dict):
            raise FargoWorkError("FargoWork endpoint returned a non-object response", code="invalid_response", exit_code=EXIT_UNAVAILABLE)
        return status, payload

    def _set_access(self, payload: Mapping[str, Any]) -> str:
        access = str(payload.get("access_token") or "")
        refresh = str(payload.get("refresh_token") or "")
        if not access or str(payload.get("token_type") or "").lower() != "bearer" or not refresh:
            raise FargoWorkError("token response did not contain the required bearer and rotated refresh token", code="invalid_token_response", exit_code=EXIT_UNAVAILABLE)
        # Atomic replacement happens in the vault backend before the in-memory token is exposed.
        self.vault.set(refresh)
        self.access_token = access
        self.access_expires_at = time.time() + max(1, int(payload.get("expires_in") or 600))
        return access

    def refresh(self) -> str:
        refresh_lock = getattr(self.vault, "refresh_lock", None)
        if callable(refresh_lock):
            with refresh_lock():
                return self._refresh_with_vault_locked()
        return self._refresh_with_vault_locked()

    def _refresh_with_vault_locked(self) -> str:
        raw_refresh = self.vault.get()
        if not raw_refresh:
            raise AuthRequired()
        status, payload = self._request_json(
            "POST",
            f"{self.config.issuer}/oauth/token",
            data={
                "grant_type": "refresh_token",
                "client_id": self.config.client_id,
                "refresh_token": raw_refresh,
                "resource": self.config.resource,
                "scope": self.config.scope,
            },
        )
        if status >= 400:
            if status in {400, 401} and str(payload.get("error")) in {"invalid_grant", "invalid_token"}:
                self.vault.delete()
                self.access_token = None
                raise AuthRequired("FargoWork refresh session is expired or revoked; login is required")
            raise FargoWorkError("FargoWork token refresh failed", code=str(payload.get("error") or "refresh_failed"), exit_code=EXIT_UNAVAILABLE)
        return self._set_access(payload)

    def access(self) -> str:
        if self.access_token and time.time() + 15 < self.access_expires_at:
            return self.access_token
        return self.refresh()

    def logout(self) -> dict[str, Any]:
        raw_refresh = self.vault.get()
        raw_access = self.access_token
        remote_error: FargoWorkError | None = None
        remote_revocation = "not_requested"
        if raw_access or raw_refresh:
            remote_revocation = "unconfirmed"
            data = {"token": raw_access or raw_refresh or ""}
            try:
                status, _payload = self._request_json("POST", f"{self.config.issuer}/oauth/logout", data=data)
                if status >= 400:
                    remote_error = FargoWorkError("FargoWork remote logout could not be confirmed", code="logout_remote_failed", exit_code=EXIT_UNAVAILABLE)
                else:
                    remote_revocation = "confirmed"
            except FargoWorkError as exc:
                remote_error = exc
            finally:
                self.vault.delete()
                self.access_token = None
                self.access_expires_at = 0
        else:
            self.vault.delete()
            self.access_token = None
            self.access_expires_at = 0
        if remote_error:
            raise FargoWorkError("FargoWork local credentials were cleared, but remote logout could not be confirmed", code="logout_remote_unavailable", exit_code=EXIT_UNAVAILABLE) from remote_error
        return {"local_credentials_cleared": True, "remote_revocation": remote_revocation}

    def me(self) -> dict[str, Any]:
        access = self.access()
        status, payload = self._request_json("GET", f"{self.config.issuer}/auth/me", headers={"Authorization": f"Bearer {access}"})
        if status == 401:
            self.access_token = None
            access = self.refresh()
            status, payload = self._request_json("GET", f"{self.config.issuer}/auth/me", headers={"Authorization": f"Bearer {access}"})
        if status >= 400:
            _diagnostic_record(self.diagnostics, "identity_result", "identity", outcome="failed", error_code="auth_required")
            raise AuthRequired("FargoWork identity could not be verified; login is required")
        if any(not isinstance(payload.get(key), str) or not payload[key].strip() or len(payload[key]) > 256 or any(ord(char) < 32 or ord(char) == 127 for char in payload[key]) for key in ("userid", "corp_id")):
            _diagnostic_record(self.diagnostics, "identity_result", "identity", outcome="failed", error_code="invalid_response")
            raise FargoWorkError("FargoWork identity response is incomplete; current identity could not be verified", code="invalid_response", exit_code=EXIT_UNAVAILABLE)
        _diagnostic_record(self.diagnostics, "identity_result", "identity", outcome="succeeded")
        return {key: payload[key] for key in ("userid", "name", "corp_id", "scope") if key in payload}

    def login(self, *, browser: str = "auto", timeout: float = 300.0) -> tuple[str, dict[str, Any]]:
        try:
            return self._login(browser=browser, timeout=timeout)
        except Exception as exc:
            _diagnostic_record(self.diagnostics, "login_finished", "finish", outcome="failed", error_code=getattr(exc, "code", "unknown_error"), exit_code=getattr(exc, "exit_code", EXIT_UNAVAILABLE))
            raise

    def _login(self, *, browser: str = "auto", timeout: float = 300.0) -> tuple[str, dict[str, Any]]:
        _diagnostic_record(self.diagnostics, "login_started", "login", outcome="started")
        verifier = _b64(secrets.token_bytes(32))
        challenge = _b64(hashlib.sha256(verifier.encode("ascii")).digest())
        state = _b64(secrets.token_bytes(32))
        callback = _CallbackWaiter(self.config.redirect_uri, expected_state=state, expected_issuer=self.config.issuer, diagnostics=self.diagnostics)
        query = urllib.parse.urlencode({
            "client_id": self.config.client_id,
            "redirect_uri": self.config.redirect_uri,
            "response_type": "code",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "resource": self.config.resource,
            "scope": self.config.scope,
            "state": state,
            "diagnostic_attempt_id": self.diagnostics.attempt_id,
        })
        auth_url = f"{self.config.issuer}/oauth/authorize?{query}"
        try:
            callback.start()
            if browser != "never":
                try:
                    opened = webbrowser.open(auth_url, new=2)
                except Exception:
                    _diagnostic_record(self.diagnostics, "browser_open_result", "browser", outcome="unavailable", error_code="browser_unavailable")
                    raise FargoWorkError("browser could not be opened; use --browser never and open the displayed URL", code="browser_unavailable", exit_code=EXIT_NEEDS_ACTION) from None
                if not opened:
                    _diagnostic_record(self.diagnostics, "browser_open_result", "browser", outcome="unavailable", error_code="browser_unavailable")
                    raise FargoWorkError("browser could not be opened; use --browser never and open the displayed URL", code="browser_unavailable", exit_code=EXIT_NEEDS_ACTION)
                _diagnostic_record(self.diagnostics, "browser_open_result", "browser", outcome="succeeded")
            else:
                _diagnostic_record(self.diagnostics, "browser_open_result", "browser", outcome="not_attempted")
            if browser == "never":
                _emit_event({"event": "login_authorization_url", "url": auth_url}, force_json=True)
            else:
                _emit_event({"event": "login_browser_opened", "message": "浏览器已打开，请完成钉钉授权，然后返回当前 AI。"}, force_json=True)
            _diagnostic_record(self.diagnostics, "authorization_waiting", "callback", outcome="waiting")
            result = callback.wait(timeout)
        finally:
            callback.close()
        if result.get("error"):
            raise AuthRequired("authorization was denied")
        if not hmac.compare_digest(str(result.get("state") or ""), state):
            raise FargoWorkError("OAuth callback state validation failed", code="oauth_state_mismatch", exit_code=EXIT_PROTOCOL)
        if str(result.get("iss") or "") != self.config.issuer:
            raise FargoWorkError("OAuth callback issuer validation failed", code="oauth_issuer_mismatch", exit_code=EXIT_PROTOCOL)
        code = str(result.get("code") or "")
        if not code:
            raise FargoWorkError("OAuth callback did not contain an authorization code", code="oauth_callback_invalid", exit_code=EXIT_PROTOCOL)
        status, payload = self._request_json(
            "POST",
            f"{self.config.issuer}/oauth/token",
            data={
                "grant_type": "authorization_code",
                "client_id": self.config.client_id,
                "redirect_uri": self.config.redirect_uri,
                "code": code,
                "code_verifier": verifier,
                "resource": self.config.resource,
            },
        )
        if status >= 400:
            raise FargoWorkError("OAuth authorization code exchange failed", code=str(payload.get("error") or "token_exchange_failed"), exit_code=EXIT_NEEDS_ACTION)
        self._set_access(payload)
        identity = self.me()
        _diagnostic_record(self.diagnostics, "login_finished", "finish", outcome="succeeded")
        return auth_url, identity


class _CallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        waiter: "_CallbackWaiter" = self.server.waiter  # type: ignore[attr-defined]
        parsed = urlsplit(self.path)
        if parsed.path != waiter.path:
            self.send_error(404)
            return
        if len(parsed.query) > 8192:
            waiter.reject(self, "oauth_callback_invalid")
            return
        params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        if any(len(values) != 1 for values in params.values()):
            waiter.reject(self, "oauth_callback_invalid")
            return
        result = {key: values[0] for key, values in params.items() if key in {"state", "iss", "code", "error"}}
        if not result.get("state", "").isascii() or not hmac.compare_digest(result.get("state", ""), waiter.expected_state):
            waiter.reject(self, "oauth_state_mismatch")
            return
        if result.get("iss", "") != waiter.expected_issuer:
            waiter.reject(self, "oauth_issuer_mismatch")
            return
        if not result.get("code") and not result.get("error"):
            waiter.reject(self, "oauth_callback_invalid")
            return
        with waiter.result_lock:
            if waiter.event.is_set():
                self.send_error(409, "This login callback was already received.")
                return
            waiter.result = result
            waiter.event.set()
        _diagnostic_record(waiter.diagnostics, "callback_accepted", "callback", outcome="matched", matched=True)
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"FargoWork callback validated. Return to your AI client to confirm that token exchange and identity verification completed.")

    def log_message(self, _format: str, *_args: Any) -> None:
        return


class _ExclusiveCallbackServer(ThreadingHTTPServer):
    # Windows needs exclusive binding; POSIX can safely reuse a closed socket
    # in TIME_WAIT while still rejecting a second active TCP listener.
    allow_reuse_address = os.name != "nt"
    allow_reuse_port = False

    def server_bind(self) -> None:
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class _CallbackWaiter:
    def __init__(self, redirect_uri: str, *, expected_state: str, expected_issuer: str, diagnostics: DiagnosticLog | None = None):
        self.expected_state = expected_state
        self.expected_issuer = expected_issuer
        self.diagnostics = diagnostics
        parsed = urlsplit(redirect_uri)
        self.path = parsed.path
        self.event = threading.Event()
        self.result: dict[str, str] = {}
        self.result_lock = threading.Lock()
        self.server: ThreadingHTTPServer | None = None
        self.thread: threading.Thread | None = None
        self.redirect_uri = redirect_uri

    def start(self) -> None:
        parsed = urlsplit(self.redirect_uri)
        host = parsed.hostname or ""
        if host not in {"127.0.0.1", "::1"} or parsed.port is None:
            raise FargoWorkError("OAuth redirect must use the fixed loopback callback", code="invalid_redirect", exit_code=EXIT_USAGE)
        try:
            self.server = _ExclusiveCallbackServer((host, parsed.port), _CallbackHandler)
        except OSError as exc:
            _diagnostic_record(self.diagnostics, "listener_failed", "listener", outcome="failed", error_code="callback_port_unavailable")
            raise FargoWorkError("OAuth callback port 37680 is unavailable. Another login may be waiting; finish or cancel that login before retrying. The existing login was left unchanged.", code="callback_port_unavailable", exit_code=EXIT_NEEDS_ACTION) from exc
        self.server.daemon_threads = True
        self.server.waiter = self  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.server.serve_forever, name="fargowork-oauth-callback", daemon=True)
        self.thread.start()
        _diagnostic_record(self.diagnostics, "listener_ready", "listener", outcome="succeeded")

    def reject(self, handler: _CallbackHandler, reason: str) -> None:
        _diagnostic_record(self.diagnostics, "callback_rejected", "callback", outcome="mismatch", error_code=reason, matched=False)
        handler.send_response(400)
        handler.send_header("Content-Type", "text/plain; charset=utf-8")
        handler.end_headers()
        handler.wfile.write(b"This callback does not belong to the waiting FargoWork login and was rejected. Open the current login link; the current login is still waiting.")

    def wait(self, timeout: float) -> dict[str, str]:
        if not self.event.wait(timeout):
            raise FargoWorkError("OAuth callback timed out", code="oauth_callback_timeout", exit_code=EXIT_NEEDS_ACTION)
        return self.result

    def close(self) -> None:
        if self.server:
            self.server.shutdown()
            self.server.server_close()


@dataclass
class HTTPResult:
    status: int
    headers: dict[str, str]
    body: bytes


class MCPHTTPClient:
    def __init__(self, session: TokenSession, *, timeout: float = 30.0):
        self.session = session
        self.timeout = timeout
        self.last_request_id: str | None = None
        self.last_server_trace_id: str | None = None
        self.last_http_status: int | None = None

    def request(self, message: Mapping[str, Any], *, method: str | None = None, retry_401: bool = True) -> dict[str, Any] | None:
        if not isinstance(message, Mapping):
            raise FargoWorkError("MCP request must be a JSON object", code="invalid_jsonrpc", exit_code=EXIT_PROTOCOL)
        wire_method = method or str(message.get("method") or "")
        if not wire_method:
            raise FargoWorkError("MCP JSON-RPC method is required", code="invalid_jsonrpc", exit_code=EXIT_PROTOCOL)
        access = self.session.access()
        result = self._post(message, wire_method, access)
        if result.status == 401 and retry_401:
            self.session.access_token = None
            access = self.session.refresh()
            result = self._post(message, wire_method, access)
        if result.status >= 400:
            raise FargoWorkError(f"MCP endpoint returned HTTP {result.status}", code="mcp_http_error", exit_code=EXIT_PROTOCOL)
        return self._decode(result)

    def _post(self, message: Mapping[str, Any], method: str, access: str) -> HTTPResult:
        request_id = diagnostic_id()
        self.last_request_id = request_id
        self.last_server_trace_id = None
        self.last_http_status = None
        started = time.monotonic()
        parsed = urlsplit(self.session.config.resource)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise FargoWorkError("MCP resource endpoint is invalid", code="invalid_config", exit_code=EXIT_USAGE)
        body = _json_bytes(dict(message))
        headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {access}",
            "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
            "Mcp-Method": method,
            "X-Trace-ID": request_id,
            "X-FargoWork-Attempt-ID": self.session.diagnostics.attempt_id,
        }
        if method == "tools/call":
            params = message.get("params")
            tool_name = params.get("name") if isinstance(params, Mapping) else None
            if not isinstance(tool_name, str) or not tool_name.strip():
                raise FargoWorkError("tools/call requires a tool name", code="invalid_params", exit_code=EXIT_PROTOCOL)
            headers["Mcp-Name"] = tool_name
        try:
            connection: http.client.HTTPConnection | None = None
            if parsed.scheme == "https":
                connection: http.client.HTTPConnection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=self.timeout)
            else:
                connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=self.timeout)
            path = parsed.path or "/"
            if parsed.query:
                path += "?" + parsed.query
            connection.request("POST", path, body=body, headers=headers)
            response = connection.getresponse()
            raw = response.read()
            response_headers = {key.lower(): value for key, value in response.getheaders()}
            self.last_http_status = response.status
            try:
                self.last_server_trace_id = diagnostic_id(response_headers.get("x-trace-id")) if response_headers.get("x-trace-id") else None
            except ValueError:
                pass
            _diagnostic_record(self.session.diagnostics, "http_request_result", "http", request_id=request_id, server_trace_id=response_headers.get("x-trace-id", ""), http_status=response.status, duration_ms=int((time.monotonic() - started) * 1000), outcome="succeeded" if response.status < 400 else "failed")
            return HTTPResult(response.status, response_headers, raw)
        except (OSError, http.client.HTTPException) as exc:
            _diagnostic_record(self.session.diagnostics, "http_request_result", "http", request_id=request_id, outcome="unavailable", error_code="endpoint_unavailable", duration_ms=int((time.monotonic() - started) * 1000))
            raise FargoWorkError(f"MCP endpoint is unavailable: {parsed.netloc}", code="mcp_unavailable", exit_code=EXIT_UNAVAILABLE) from exc
        finally:
            try:
                if connection is not None:
                    connection.close()
            except Exception:
                pass

    @staticmethod
    def _decode(response: HTTPResult) -> dict[str, Any] | None:
        if not response.body:
            return None
        content_type = response.headers.get("content-type", "")
        if "text/event-stream" in content_type:
            data_lines = []
            for line in response.body.decode("utf-8", "replace").splitlines():
                if line.startswith("data:"):
                    data_lines.append(line[5:].lstrip())
            if not data_lines:
                return None
            payload = json.loads(data_lines[-1])
        else:
            payload = json.loads(response.body.decode("utf-8"))
        if not isinstance(payload, dict):
            raise FargoWorkError("MCP endpoint returned a non-object JSON-RPC response", code="mcp_invalid_response", exit_code=EXIT_PROTOCOL)
        return payload


def _modern_meta(message: Mapping[str, Any]) -> dict[str, Any]:
    params_value = message.get("params")
    if params_value is not None and not isinstance(params_value, Mapping):
        raise FargoWorkError("MCP JSON-RPC params must be an object", code="invalid_params", exit_code=EXIT_PROTOCOL)
    params = dict(params_value or {})
    meta_value = params.get("_meta")
    if meta_value is not None and not isinstance(meta_value, Mapping):
        raise FargoWorkError("MCP JSON-RPC params._meta must be an object", code="invalid_params", exit_code=EXIT_PROTOCOL)
    meta = dict(meta_value or {})
    meta["io.modelcontextprotocol/protocolVersion"] = MCP_PROTOCOL_VERSION
    client_info = params.get("clientInfo")
    client_capabilities = params.get("capabilities")
    meta.setdefault("io.modelcontextprotocol/clientInfo", {"name": "fargowork-cli", "version": VERSION})
    meta.setdefault(
        "io.modelcontextprotocol/clientCapabilities",
        dict(client_capabilities) if isinstance(client_capabilities, Mapping) else {},
    )
    if isinstance(client_info, Mapping):
        meta["io.modelcontextprotocol/clientInfo"] = dict(client_info)
    return meta


def _with_modern_meta(message: Mapping[str, Any]) -> dict[str, Any]:
    translated = dict(message)
    meta = _modern_meta(message)
    params = dict(message.get("params") or {})
    params["_meta"] = meta
    translated["params"] = params
    return translated


MAX_TOOL_INPUT_BYTES = 64 * 1024
MAX_TOOL_PAGES = 32
MAX_PUBLIC_TOOLS = 512
_TOOL_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_.:\-]{0,127}\Z")
_TOOL_RESERVED_INPUTS = frozenset((
    "userid", "user_id", "corp_id", "corpId", "operator_userid", "operator_corp_id",
    "actor_userid", "identity_subject_hash", "authorization", "bearer", "access_token",
    "refresh_token", "client_secret", "headers", "endpoint", "issuer", "resource",
    "resource_metadata_uri", "_meta", "form_data", "form_uuid", "process_code", "process_data",
))


class BusinessToolError(FargoWorkError):
    """A bounded CLI failure, carrying only a public result and safe trace IDs."""

    def __init__(self, code: str, *, kind: str, exit_code: int = EXIT_PROTOCOL,
                 result: dict[str, Any] | None = None, trace: dict[str, Any] | None = None,
                 rpc_code: int | None = None):
        super().__init__("FargoWork business command could not complete", code=code, exit_code=exit_code)
        self.kind = kind
        self.result = result
        self.trace = trace or {}
        self.rpc_code = rpc_code


def _tool_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _tool_arguments(args: argparse.Namespace) -> dict[str, Any]:
    """Read one bounded UTF-8 arguments object; never execute or echo input."""
    try:
        if args.input_file is not None:
            path = args.input_file
            if _is_link_or_reparse(path) or not path.is_file():
                raise ValueError("input must be a regular file")
            with path.open("rb") as source:
                raw = source.read(MAX_TOOL_INPUT_BYTES + 1)
            if len(raw) > MAX_TOOL_INPUT_BYTES:
                raise ValueError("input too large")
            text = raw.decode("utf-8-sig")
        elif args.input_json is not None:
            text = args.input_json
        elif getattr(sys.stdin, "isatty", lambda: False)():
            text = ""
        else:
            # Windows redirected stdin may use a legacy text encoding. The
            # business input contract is UTF-8, independent of that wrapper.
            source = getattr(sys.stdin, "buffer", None)
            if source is not None:
                raw = source.read(MAX_TOOL_INPUT_BYTES + 1)
                if len(raw) > MAX_TOOL_INPUT_BYTES:
                    raise ValueError("input too large")
                text = raw.decode("utf-8-sig")
            else:
                # StringIO and other already-decoded caller/test streams.
                text = sys.stdin.read(MAX_TOOL_INPUT_BYTES + 1)
        if len(text.encode("utf-8")) > MAX_TOOL_INPUT_BYTES:
            raise ValueError("input too large")
        def reject_constant(_value: str) -> None:
            raise ValueError("non-finite JSON value")
        value = json.loads(text, object_pairs_hook=_tool_json_object,
                           parse_constant=reject_constant) if text.strip() else {}
        if not isinstance(value, dict):
            raise ValueError("arguments must be an object")
        def check_keys(item: Any, depth: int = 0) -> None:
            if depth > 32:
                raise ValueError("input nesting too deep")
            if isinstance(item, dict):
                for key, child in item.items():
                    if key in _TOOL_RESERVED_INPUTS or key.lower() in {"authorization", "bearer", "access_token", "refresh_token", "client_secret"}:
                        raise ValueError("managed identity or transport input")
                    check_keys(child, depth + 1)
            elif isinstance(item, list):
                for child in item:
                    check_keys(child, depth + 1)
        check_keys(value)
        return value
    except (OSError, UnicodeError, ValueError, TypeError, RecursionError):
        raise BusinessToolError("tool_input_invalid", kind="input", exit_code=EXIT_USAGE) from None


def _public_tool_result(value: Any, *, access_token: str | None = None) -> Any:
    """Preserve the Server's public business object, never credential fields."""
    secrets = {"token", "access_token", "refresh_token", "secret", "client_secret", "authorization",
               "cookie", "cookies", "code_verifier", "private_key", "password", "headers"}
    if isinstance(value, Mapping):
        return {str(key): _public_tool_result(item, access_token=access_token)
                for key, item in value.items() if str(key).lower() not in secrets}
    if isinstance(value, list):
        return [_public_tool_result(item, access_token=access_token) for item in value]
    if isinstance(value, str):
        if access_token:
            value = value.replace(access_token, "[REDACTED]")
        return re.sub(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=\-]+", "Bearer [REDACTED]", value)
    return value


class EmployeeToolsClient:
    """Official CLI facade over the same authenticated employee MCP resource.

    The employee Server publishes the public catalog. No workflow, identity,
    role decision or submission confirmation is implemented in this facade.
    Every command rediscovers the catalog and sends a business call at most once.
    """

    def __init__(self, session: TokenSession):
        self.session = session
        self.http = MCPHTTPClient(session)
        self.identity: dict[str, Any] = {}
        self.server_info: dict[str, Any] = {}

    def trace(self) -> dict[str, Any]:
        return {key: value for key, value in {
            "request_id": self.http.last_request_id,
            "server_trace_id": self.http.last_server_trace_id,
            "http_status": self.http.last_http_status,
        }.items() if value is not None}

    def _rpc(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        request_id = diagnostic_id()
        message = _with_modern_meta({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        try:
            # No 401 replay for this facade: even a failed tool call is never
            # repeated. A subsequent user command may sign in and start anew.
            response = self.http.request(message, method=method, retry_401=False)
        except FargoWorkError as exc:
            if self.http.last_http_status == 401:
                raise BusinessToolError("auth_required", kind="auth", exit_code=EXIT_NEEDS_ACTION, trace=self.trace()) from None
            if self.http.last_http_status is not None and self.http.last_http_status >= 400:
                raise BusinessToolError("tool_http_error", kind="server", trace=self.trace()) from None
            raise BusinessToolError("tool_transport_failed", kind="transport", exit_code=EXIT_UNAVAILABLE, trace=self.trace()) from None
        except (ValueError, UnicodeError, TypeError):
            raise BusinessToolError("tool_response_invalid", kind="transport", trace=self.trace()) from None
        if not isinstance(response, Mapping) or response.get("jsonrpc") != "2.0" or response.get("id") != request_id:
            raise BusinessToolError("tool_response_invalid", kind="transport", trace=self.trace())
        if "error" in response:
            error = response.get("error")
            rpc_code = error.get("code") if isinstance(error, Mapping) else None
            raise BusinessToolError("tool_server_error", kind="server", trace=self.trace(),
                                    rpc_code=rpc_code if type(rpc_code) is int else None)
        result = response.get("result")
        if not isinstance(result, dict):
            raise BusinessToolError("tool_response_invalid", kind="transport", trace=self.trace())
        return result

    def discover(self) -> list[dict[str, Any]]:
        self.identity = self.session.me()
        discovery = self._rpc("server/discover", {})
        if MCP_PROTOCOL_VERSION not in discovery.get("supportedVersions", []):
            raise BusinessToolError("mcp_protocol_version_unsupported", kind="transport", trace=self.trace())
        capabilities = discovery.get("capabilities") or discovery.get("serverCapabilities")
        if not isinstance(capabilities, Mapping) or not isinstance(capabilities.get("tools"), Mapping):
            raise BusinessToolError("tools_discovery_invalid", kind="transport", trace=self.trace())
        info = discovery.get("serverInfo")
        if isinstance(info, Mapping) and all(isinstance(info.get(key), str) for key in ("name", "version")):
            self.server_info = {key: info[key] for key in ("name", "version")}
        tools: list[dict[str, Any]] = []
        names: set[str] = set()
        cursors: set[str] = set()
        cursor = None
        for _ in range(MAX_TOOL_PAGES):
            page = self._rpc("tools/list", {"cursor": cursor} if cursor is not None else {})
            entries = page.get("tools")
            if not isinstance(entries, list):
                raise BusinessToolError("tools_discovery_invalid", kind="transport", trace=self.trace())
            for entry in entries:
                if not isinstance(entry, dict) or not isinstance(entry.get("name"), str) or not _TOOL_NAME.fullmatch(entry["name"]):
                    raise BusinessToolError("tools_discovery_invalid", kind="transport", trace=self.trace())
                name = entry["name"]
                if name in names or not isinstance(entry.get("inputSchema"), dict):
                    raise BusinessToolError("tools_discovery_invalid", kind="transport", trace=self.trace())
                names.add(name)
                if len(names) > MAX_PUBLIC_TOOLS:
                    raise BusinessToolError("tools_discovery_invalid", kind="transport", trace=self.trace())
                metadata = entry.get("_meta") if isinstance(entry.get("_meta"), Mapping) else {}
                if entry.get("visibility", metadata.get("visibility", "public")) != "public":
                    continue
                tools.append(_public_tool_result(entry, access_token=self.session.access_token))
            cursor = page.get("nextCursor")
            if cursor is None:
                return tools
            if not isinstance(cursor, str) or not cursor or len(cursor) > 1024 or cursor in cursors:
                raise BusinessToolError("tools_discovery_invalid", kind="transport", trace=self.trace())
            cursors.add(cursor)
        raise BusinessToolError("tools_discovery_invalid", kind="transport", trace=self.trace())

    def call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if not _TOOL_NAME.fullmatch(name):
            raise BusinessToolError("tool_not_public", kind="input", exit_code=EXIT_USAGE)
        catalog = {item["name"]: item for item in self.discover()}
        if name not in catalog:
            raise BusinessToolError("tool_not_public", kind="input", exit_code=EXIT_USAGE, trace=self.trace())
        schema = catalog[name]["inputSchema"]
        properties = schema.get("properties")
        if isinstance(properties, Mapping) and any(key not in properties for key in arguments):
            raise BusinessToolError("tool_input_invalid", kind="input", exit_code=EXIT_USAGE, trace=self.trace())
        result = self._rpc("tools/call", {"name": name, "arguments": arguments})
        if not isinstance(result.get("content"), list) or ("isError" in result and type(result["isError"]) is not bool):
            raise BusinessToolError("tool_response_invalid", kind="transport", trace=self.trace())
        safe = _public_tool_result(result, access_token=self.session.access_token)
        # SDK exception text is not the governed public contract. Do not echo
        # opaque server exception messages; structured public results survive.
        if safe.get("isError") is True and not isinstance(safe.get("structuredContent"), Mapping):
            safe = {"isError": True}
        elif isinstance(safe.get("structuredContent"), Mapping):
            safe["content"] = [{"type": "text", "text": json.dumps(safe["structuredContent"], ensure_ascii=False)}]
        else:
            for item in safe.get("content", []):
                if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
                    try:
                        value = json.loads(item["text"])
                    except ValueError:
                        continue
                    item["text"] = json.dumps(_public_tool_result(value, access_token=self.session.access_token), ensure_ascii=False)
        if safe.get("isError") is True:
            raise BusinessToolError("tool_server_error", kind="server", result=safe, trace=self.trace())
        return safe


def _emit_business_result(payload: Mapping[str, Any]) -> None:
    log = _DIAGNOSTIC_CONTEXT.get()
    if log is not None:
        payload = {**payload, "attempt_id": log.attempt_id, "diagnostic_log_dir": str(log.root),
                   "diagnostic_write_failed": log.write_failed}
    print(json.dumps(_public_tool_result(payload), ensure_ascii=True, separators=(",", ":")), flush=True)


def _business_error_payload(error: FargoWorkError, config: "Config | None" = None) -> dict[str, Any]:
    kind = getattr(error, "kind", None)
    if kind is None:
        kind = "auth" if error.code in {"auth_required", "invalid_grant", "invalid_token", "secure_storage_unavailable"} else "input" if error.exit_code == EXIT_USAGE else "transport"
    messages = {
        "input": "Use a published tool name and one UTF-8 JSON arguments object; managed identity, credentials and endpoint overrides are not accepted.",
        "auth": "FargoWork login is required. Use the official employee CLI login command.",
        "transport": "FargoWork could not confirm the response. Stop; no business retry was performed. Provide the support trace.",
        "server": "The FargoWork Server rejected or could not complete the request. Follow any public result and provide the support trace; no business retry was performed.",
    }
    payload: dict[str, Any] = {"event": "error", "status": "error", "error_kind": kind,
        "error_code": safe_error_code(error.code), "exit_code": error.exit_code,
        "message": messages[kind], "automatic_retry_allowed": False, **getattr(error, "trace", {})}
    if getattr(error, "result", None) is not None:
        payload["result"] = error.result
    if getattr(error, "rpc_code", None) is not None:
        payload["server_error_code"] = error.rpc_code
    if kind == "auth":
        payload["next_action"] = "login"
        if config is not None:
            payload["login_command"] = str(config.home / "bin" / ("fargowork.exe" if platform.system() == "Windows" else "fargowork"))
            payload["login_args"] = ["login", "--browser", "always"]
    return payload


def _configure_utf8_stream(stream: Any) -> None:
    reconfigure = getattr(stream, "reconfigure", None)
    if not callable(reconfigure):
        return
    try:
        reconfigure(encoding="utf-8", errors="strict")
    except (OSError, ValueError):
        # In-memory and already-consumed streams may reject reconfiguration.
        # Their caller remains responsible for supplying a Unicode-safe stream.
        return


def _emit_event(payload: Mapping[str, Any], *, force_json: bool = False, output: str = "human") -> None:
    log = _DIAGNOSTIC_CONTEXT.get()
    if log is not None:
        payload = {**payload, "attempt_id": log.attempt_id, "diagnostic_log_dir": str(log.root), "diagnostic_write_failed": log.write_failed}
    if force_json or output == "jsonl":
        # ASCII escapes preserve Unicode paths through Windows PowerShell 5.1
        # native-command pipes, regardless of the console's current code page.
        print(json.dumps(_safe_no_secret(dict(payload)), ensure_ascii=True, separators=(",", ":")), flush=True)
        return
    event = payload.get("event") or payload.get("status") or "result"
    details = payload.get("message") or payload.get("reason") or ""
    print(f"{event}: {details}".rstrip(": "), flush=True)


def _compatibility_contract() -> dict[str, Any]:
    return {
        "mcp_protocol_versions": [MCP_PROTOCOL_VERSION],
        "agent_plugins_spec": AGENT_PLUGINS_SPEC_VERSION,
        "action_result_contract": ACTION_RESULT_CONTRACT_VERSION,
    }


def _canonical_skill_path(config: Config) -> Path:
    return config.home / "skills" / PLUGIN_NAME


def _prepare_canonical_skill(config: Config) -> None:
    source = config.plugin_dir / "skills" / PLUGIN_NAME
    target = _canonical_skill_path(config)
    _assert_path_within(config.home, target, label="employee Skill")
    if not source.joinpath("SKILL.md").is_file():
        raise FargoWorkError("the employee plugin does not contain its core Skill", code="skill_missing", exit_code=EXIT_UNAVAILABLE)
    if target.exists() and not _owned_path(target):
        raise FargoWorkError("refusing to overwrite an unowned employee Skill", code="ownership_conflict", exit_code=EXIT_NEEDS_ACTION)
    _copy_managed_skill(source, target)


def _client_trust(clients: Mapping[str, Mapping[str, Any]], target: str) -> bool | str:
    if target == "cli":
        return "not_required"
    if target != "all":
        return clients.get(target, {}).get("trusted", "unknown")
    return clients.get("workbuddy", {}).get("trusted", "unknown")


def _clients_need_action(
    clients: Mapping[str, Mapping[str, Any]], *, target: str
) -> bool:
    return any(
        bool(client.get("needs_user_action"))
        and (target not in {"all", "auto"} or bool(client.get("detected")) or client.get("registered") is True)
        for client in clients.values()
    )


def _registration_failed(clients: Mapping[str, Mapping[str, Any]], target: str) -> bool:
    return target not in {"manual", "cli"} and any(
        client.get("registered") is not True and (
            bool(client.get("detected")) or target not in {"all", "auto"}
        ) for client in clients.values()
    )


def _status_payload(
    config: Config,
    *,
    clients: dict[str, Any],
    target: str = "cli",
    connected: bool | None = None,
    identity: dict[str, Any] | None = None,
) -> dict[str, Any]:
    plugin_ready = (config.plugin_dir / "plugin.json").is_file()
    if target == "cli":
        executable = config.home / "bin" / ("fargowork.exe" if platform.system() == "Windows" else "fargowork")
        plugin_ready = executable.is_file() and (_canonical_skill_path(config) / "SKILL.md").is_file()
    needs_action = (
        target == "manual"
        or not plugin_ready
        or connected is not True
        or _clients_need_action(clients, target=target)
    )
    payload = {
        "event": "status",
        "status": ("ready" if not needs_action else "needs_user_action") if target == "cli" and plugin_ready else "ok" if plugin_ready else "not_installed",
        "target": target,
        "version": VERSION,
        "compatibility": _compatibility_contract(),
        "installed": plugin_ready,
        "connected": connected,
        "identity_verified": connected is True and identity is not None,
        "mutation_may_have_happened": any(bool(client.get("mutation_may_have_happened")) for client in clients.values()),
        "trusted": _client_trust(clients, target),
        "needs_user_action": needs_action,
        "config": {
            "home": str(config.home),
            "plugin_dir": str(config.plugin_dir),
            "environment": config.environment,
            "issuer": config.issuer,
            "resource": config.resource,
            "redirect_uri": config.redirect_uri,
            "client_id": config.client_id,
            "scope": config.scope,
        },
        "clients": clients,
        "skill_path": str(_canonical_skill_path(config) / "SKILL.md"),
    }
    if target == "cli":
        payload.update(connection_mode="cli", mcp_registration_required=False,
                       business_cli_available=plugin_ready, tool_capability="not_checked")
    if identity:
        payload["identity"] = identity
    return payload


def _detect_command(*names: str) -> dict[str, Any]:
    for name in names:
        path = shutil.which(name)
        if path:
            return {"detected": True, "executable": path}
    return {"detected": False, "executable": None}


def _explicit_codex_path(value: str) -> str:
    path = Path(value).expanduser()
    if not path.is_absolute() or path.name.lower() not in {"codex", "codex.exe"}:
        raise FargoWorkError("--codex-path must be an absolute path to codex.exe (or codex)", code="client_not_detected", exit_code=EXIT_NEEDS_ACTION)
    if _is_link_or_reparse(path) or not path.is_file():
        raise FargoWorkError("The specified Codex executable is unavailable; supply its current path. No alternate executable was guessed.", code="client_not_detected", exit_code=EXIT_NEEDS_ACTION)
    return str(path.absolute())


def _owned_path(path: Path) -> bool:
    if _is_link_or_reparse(path):
        return False
    marker = path / ".fargowork-owner" if path.is_dir() else path
    if _is_link_or_reparse(marker):
        return False
    if marker.is_file():
        try:
            text = marker.read_text(encoding="utf-8").strip()
            if text == MARKER:
                return True
            value = json.loads(text)
            return isinstance(value, dict) and value.get("owner") == MARKER
        except OSError:
            return False
        except (TypeError, ValueError, json.JSONDecodeError):
            return False
    return False


def _is_link_or_reparse(path: Path) -> bool:
    try:
        if path.is_symlink():
            return True
        attributes = int(getattr(path.lstat(), "st_file_attributes", 0) or 0)
        return bool(attributes & 0x400)  # FILE_ATTRIBUTE_REPARSE_POINT
    except OSError:
        return True


def _assert_path_within(base: Path, child: Path, *, label: str) -> None:
    base_resolved = base.resolve(strict=False)
    child_resolved = child.resolve(strict=False)
    try:
        child_resolved.relative_to(base_resolved)
    except ValueError as exc:
        raise FargoWorkError(f"{label} escapes the FargoWork home", code="unsafe_path", exit_code=EXIT_USAGE) from exc


def _assert_host_location(path: Path) -> None:
    for parent in (path, *path.parents):
        if (parent.exists() or parent.is_symlink()) and _is_link_or_reparse(parent):
            raise FargoWorkError("client configuration path contains a symlink or reparse point", code="unsafe_path", exit_code=EXIT_NEEDS_ACTION)


def _assert_safe_tree(root: Path, *, label: str) -> None:
    if not root.exists() and not root.is_symlink():
        return
    if _is_link_or_reparse(root):
        raise FargoWorkError(f"{label} contains a symlink or reparse point", code="unsafe_path", exit_code=EXIT_USAGE)
    root_resolved = root.resolve(strict=True)
    if not root.is_dir():
        return
    for current, directories, files in os.walk(root, topdown=True, followlinks=False):
        for name in [*directories, *files]:
            path = Path(current) / name
            if _is_link_or_reparse(path):
                raise FargoWorkError(f"{label} contains a symlink or reparse point", code="unsafe_path", exit_code=EXIT_USAGE)
            try:
                path.resolve(strict=True).relative_to(root_resolved)
            except (OSError, ValueError) as exc:
                raise FargoWorkError(f"{label} contains a path escape", code="unsafe_path", exit_code=EXIT_USAGE) from exc


def _remove_owned_tree(base: Path, target: Path, *, label: str) -> None:
    _assert_path_within(base, target, label=label)
    _assert_safe_tree(target, label=label)
    if not target.is_dir() or not _owned_path(target):
        raise FargoWorkError(f"refusing to remove an unowned {label}", code="ownership_conflict", exit_code=EXIT_NEEDS_ACTION)
    shutil.rmtree(target)


def _copy_tree_atomic(source: Path, target: Path, *, owner_metadata: dict[str, Any] | None = None) -> None:
    if not source.is_dir():
        raise FargoWorkError(f"plugin source directory is missing: {source}", code="plugin_missing", exit_code=EXIT_UNAVAILABLE)
    _assert_safe_tree(source, label="plugin source")
    if target.exists() or target.is_symlink():
        _assert_safe_tree(target, label="existing plugin")
    backup = target.with_name(target.name + ".backup")
    if backup.exists() or backup.is_symlink():
        _assert_safe_tree(backup, label="plugin backup")
        if not backup.is_dir() or not _owned_path(backup):
            raise FargoWorkError("refusing to replace an unowned plugin backup", code="ownership_conflict", exit_code=EXIT_NEEDS_ACTION)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = Path(tempfile.mkdtemp(prefix=f".{target.name}-", dir=str(target.parent)))
    old_moved = False
    try:
        shutil.copytree(source, temp / target.name, dirs_exist_ok=True)
        marker = temp / target.name / ".fargowork-owner"
        marker.write_bytes(_json_bytes({"owner": MARKER, **owner_metadata}) if owner_metadata else (MARKER + "\n").encode("utf-8"))
        if target.exists() and not _owned_path(target):
            raise FargoWorkError(f"refusing to overwrite a non-FargoWork plugin directory: {target}", code="ownership_conflict", exit_code=EXIT_NEEDS_ACTION)
        if target.exists():
            if backup.exists():
                shutil.rmtree(backup)
            os.replace(target, backup)
            old_moved = True
        os.replace(temp / target.name, target)
    except Exception:
        if old_moved and backup.exists() and not _is_link_or_reparse(backup):
            if target.exists():
                shutil.rmtree(target, ignore_errors=True)
            os.replace(backup, target)
        raise
    finally:
        shutil.rmtree(temp, ignore_errors=True)


def _tree_hashes(root: Path) -> dict[str, str]:
    _assert_safe_tree(root, label="skill tree")
    hashes: dict[str, str] = {}
    if not root.is_dir():
        return hashes
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix()
        if relative == ".fargowork-owner":
            continue
        hashes[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


def _copy_managed_skill(source: Path, target: Path) -> None:
    expected = _tree_hashes(source)
    if target.exists():
        if not _owned_path(target):
            raise FargoWorkError("refusing to overwrite an unowned Skill", code="ownership_conflict", exit_code=EXIT_NEEDS_ACTION)
        current = _tree_hashes(target)
        try:
            marker = json.loads((target / ".fargowork-owner").read_text(encoding="utf-8"))
        except (OSError, ValueError, json.JSONDecodeError):
            marker = {}
        baseline = marker.get("source_hashes") if isinstance(marker, dict) else None
        if current != (baseline if isinstance(baseline, dict) else expected):
            raise FargoWorkError("the installed Skill contains local changes; it was preserved", code="modified_skill_preserved", exit_code=EXIT_NEEDS_ACTION)
    _copy_tree_atomic(source, target, owner_metadata={"source_hashes": expected})


def _adopt_identical_tree(source: Path, target: Path) -> bool:
    """Adopt an exact prior FargoWork copy without overwriting foreign content."""
    if not target.is_dir() or _owned_path(target):
        return _owned_path(target)
    if _tree_hashes(source) != _tree_hashes(target):
        return False
    (target / ".fargowork-owner").write_text(MARKER + "\n", encoding="utf-8")
    return True


class LegacyBridgeMigration:
    """Remove only proven old registrations; never create a host connection."""

    def __init__(self, config: Config):
        self.config = config

    def _bridge_command(self) -> str:
        # Historical receipt comparison only; this launcher is no longer shipped.
        return str(self.config.plugin_dir / "bin" / ("fargowork.cmd" if platform.system() == "Windows" else "fargowork"))

    def _native_bridge_command(self) -> str:
        return str(self.config.plugin_dir / "bin" / ("fargowork.exe" if platform.system() == "Windows" else "fargowork"))

    def _detect_codex(self) -> dict[str, Any]:
        if self.config.codex_path:
            try:
                path = _explicit_codex_path(self.config.codex_path)
                return {"detected": True, "executable": path, "detection": "explicit-path"}
            except FargoWorkError:
                return {"detected": False, "executable": None, "detection": "explicit-path-unavailable", "reason": "Configured Codex executable is unavailable; use --codex-path with the current path. No alternate executable was guessed."}
        return _detect_command("codex")


    @staticmethod
    def _host_json(path: Path) -> tuple[dict[str, Any], bytes | None]:
        _assert_host_location(path)
        if not path.exists():
            return {}, None
        if _is_link_or_reparse(path) or not path.is_file():
            raise FargoWorkError("client configuration is not a regular owned-location file", code="unsafe_path", exit_code=EXIT_NEEDS_ACTION)
        original = path.read_bytes()
        try:
            def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
                value: dict[str, Any] = {}
                for key, item in pairs:
                    if key in value:
                        raise ValueError("duplicate client configuration key")
                    value[key] = item
                return value
            payload = json.loads(original.decode("utf-8-sig"), object_pairs_hook=unique_object)
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as exc:
            raise FargoWorkError("client configuration is unreadable; it was preserved", code="invalid_client_config", exit_code=EXIT_NEEDS_ACTION) from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("mcpServers", {}), dict):
            raise FargoWorkError("client MCP configuration has an unsupported shape; it was preserved", code="invalid_client_config", exit_code=EXIT_NEEDS_ACTION)
        return payload, original


    @staticmethod
    def _write_host_json(path: Path, payload: dict[str, Any], original: bytes | None) -> None:
        current = path.read_bytes() if path.exists() else None
        if current != original:
            raise FargoWorkError("client configuration changed during registration; retry after reviewing it", code="client_config_changed", exit_code=EXIT_NEEDS_ACTION)
        _atomic_write(path, _json_bytes(payload))


    def _host_entry_matches(self, entry: Any) -> bool:
        return (
            isinstance(entry, dict)
            and entry.get("type", "stdio") == "stdio"
            and self._normalized_codex_command(entry.get("command")) == self._normalized_codex_command(self._native_bridge_command())
            and entry.get("args") == ["bridge"]
            and entry.get("env", {}) == {}
            and not (set(entry) - {"type", "command", "args", "env"})
        )


    def _foreign_or_owned_entry(self, path: Path) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        _assert_path_within(self.config.home, path, label="client adapter state")
        if not path.exists() and not path.is_symlink():
            return None, None
        if _is_link_or_reparse(path):
            raise FargoWorkError(f"client adapter state contains a symlink or reparse point: {path}", code="unsafe_path", exit_code=EXIT_USAGE)
        try:
            current = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise FargoWorkError(f"client adapter state is unreadable: {path}", code="adapter_state_invalid", exit_code=EXIT_NEEDS_ACTION) from exc
        if not isinstance(current, dict):
            raise FargoWorkError(f"client adapter state is invalid: {path}", code="adapter_state_invalid", exit_code=EXIT_NEEDS_ACTION)
        if current.get("owner") != MARKER:
            return current, None
        return None, current


    @staticmethod
    def _codex_inventory_entries(payload: Any) -> dict[str, dict[str, Any]]:
        container = payload
        if isinstance(payload, dict):
            for key in ("servers", "mcp_servers", "mcpServers"):
                if key in payload:
                    container = payload[key]
                    break
            else:
                if any(key in payload for key in ("command", "url", "args")):
                    name = str(payload.get("name") or "")
                    return {name: payload} if name else {}
        entries: dict[str, dict[str, Any]] = {}
        if isinstance(container, list):
            for item in container:
                if not isinstance(item, dict):
                    raise ValueError("Codex MCP inventory contains a non-object entry")
                name = str(item.get("name") or item.get("id") or "")
                if not name or name in entries:
                    raise ValueError("Codex MCP inventory contains a missing or duplicate name")
                entries[name] = item
            return entries
        if isinstance(container, dict):
            for name, item in container.items():
                if not isinstance(name, str) or not isinstance(item, dict):
                    raise ValueError("Codex MCP inventory has an unsupported shape")
                entries[name] = item
            return entries
        raise ValueError("Codex MCP inventory has an unsupported shape")


    @staticmethod
    def _codex_get_entry(payload: Any, expected_name: str) -> dict[str, Any]:
        value = payload
        if isinstance(value, list):
            matches = [item for item in value if isinstance(item, dict) and item.get("name") == expected_name]
            if len(matches) != 1:
                raise ValueError("Codex MCP get response did not contain one named entry")
            value = matches[0]
        if not isinstance(value, dict):
            raise ValueError("Codex MCP get response is not an object")
        for key in ("server", "mcp_server", "mcpServer"):
            if isinstance(value.get(key), dict):
                value = value[key]
                break
        if isinstance(value.get("config"), dict):
            config = dict(value["config"])
            if "name" in value:
                config["name"] = value["name"]
            value = config
        elif expected_name in value and isinstance(value[expected_name], dict):
            value = value[expected_name]
        name = value.get("name")
        if name != expected_name:
            raise ValueError("Codex MCP get returned a different entry")
        if not isinstance(value.get("enabled"), bool):
            raise ValueError("Codex MCP get response did not include an enabled state")
        transport = value.get("transport")
        if not isinstance(transport, dict) or not isinstance(transport.get("type"), str) or not transport["type"]:
            raise ValueError("Codex MCP get response did not include a valid transport")
        if transport["type"] == "stdio":
            if not {"command", "args", "env", "env_vars", "cwd"}.issubset(transport):
                raise ValueError("Codex stdio transport is missing required fields")
            if not isinstance(transport.get("command"), str) or not transport["command"]:
                raise ValueError("Codex stdio transport did not include a command")
            if not isinstance(transport.get("args"), list) or not all(isinstance(arg, str) for arg in transport["args"]):
                raise ValueError("Codex stdio transport did not include valid arguments")
            environment = transport.get("env")
            if environment is not None and not isinstance(environment, dict):
                raise ValueError("Codex stdio transport environment is not an object")
            environment_names = transport.get("env_vars")
            if environment_names is not None and (
                not isinstance(environment_names, list)
                or not all(isinstance(name, str) for name in environment_names)
            ):
                raise ValueError("Codex stdio transport environment names are invalid")
            cwd = transport.get("cwd")
            if cwd is not None and (not isinstance(cwd, str) or not cwd):
                raise ValueError("Codex stdio transport working directory is invalid")
        elif "url" in transport and not isinstance(transport.get("url"), str):
            raise ValueError("Codex remote transport URL is invalid")
        return value


    def _codex_mcp_state(self, executable: str) -> dict[str, Any]:
        try:
            inventory_result = subprocess.run(
                [executable, "mcp", "list", "--json"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
                timeout=15,
            )
        except (OSError, subprocess.TimeoutExpired):
            return {"status": "error"}
        if inventory_result.returncode != 0:
            return {"status": "error"}
        try:
            inventory = self._codex_inventory_entries(json.loads(inventory_result.stdout))
        except (TypeError, ValueError, json.JSONDecodeError):
            return {"status": "error"}
        if PLUGIN_NAME not in inventory:
            return {"status": "absent"}
        try:
            get_result = subprocess.run(
                [executable, "mcp", "get", PLUGIN_NAME, "--json"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
                timeout=15,
            )
        except (OSError, subprocess.TimeoutExpired):
            return {"status": "error"}
        if get_result.returncode != 0:
            return {"status": "error"}
        try:
            entry = self._codex_get_entry(json.loads(get_result.stdout), PLUGIN_NAME)
        except (TypeError, ValueError, json.JSONDecodeError):
            return {"status": "error"}
        return {"status": "present", "entry": entry}


    @staticmethod
    def _normalized_codex_command(value: Any) -> str:
        if not isinstance(value, str) or not value:
            return ""
        return os.path.normcase(os.path.normpath(value.strip()))


    def _codex_native_entry_matches(self, entry: Mapping[str, Any]) -> bool:
        expected_command = self._normalized_codex_command(self._bridge_command())
        transport = entry.get("transport")
        if (
            not isinstance(transport, Mapping)
            or transport.get("type") != "stdio"
            or not {"command", "args", "env", "env_vars", "cwd"}.issubset(transport)
        ):
            return False
        command = self._normalized_codex_command(transport.get("command"))
        args = transport.get("args")
        environment = transport.get("env", {})
        environment_names = transport.get("env_vars", [])
        cwd = transport.get("cwd")
        enabled = entry.get("enabled")
        if environment is None:
            environment = {}
        return (
            command == expected_command
            and isinstance(args, list)
            and args == ["bridge"]
            and isinstance(environment, dict)
            and environment == {}
            and environment_names in (None, [])
            and (cwd is None or (isinstance(cwd, str) and bool(cwd)))
            and enabled is True
        )


    def _codex_sidecar_matches(self, sidecar: Mapping[str, Any], entry: Mapping[str, Any]) -> bool:
        if sidecar.get("registration") != "official-codex-cli":
            return False
        if self._normalized_codex_command(sidecar.get("command")) != self._normalized_codex_command(self._bridge_command()):
            return False
        if sidecar.get("args") != ["bridge"] or sidecar.get("env", {}) != {}:
            return False
        transport = entry.get("transport")
        if not isinstance(transport, Mapping) or "cwd" not in sidecar:
            return False
        sidecar_cwd = sidecar.get("cwd")
        entry_cwd = transport.get("cwd")
        if sidecar_cwd is None:
            if entry_cwd is not None:
                return False
        elif (
            not isinstance(sidecar_cwd, str)
            or not isinstance(entry_cwd, str)
            or os.path.normcase(os.path.normpath(sidecar_cwd)) != os.path.normcase(os.path.normpath(entry_cwd))
        ):
            return False
        return self._codex_native_entry_matches(entry)


    def _json_registration(self, name: str, config_path: Path, registration: str) -> dict[str, Any]:
        sidecar_path = self.config.home / "adapters" / f"{name}.json"
        foreign, owned = self._foreign_or_owned_entry(sidecar_path)
        payload, original = self._host_json(config_path)
        current = payload.get("mcpServers", {}).get(PLUGIN_NAME)
        if current is None:
            if owned and owned.get("registration") == registration:
                sidecar_path.unlink()
            return {"status": "absent", "needs_user_action": False}
        if (foreign is not None or not owned or owned.get("registration") != registration
                or owned.get("entry") != current or not self._host_entry_matches(current)):
            return {"status": "preserved", "needs_user_action": True,
                    "reason": "Old same-name connection is foreign or modified; it was preserved."}
        del payload["mcpServers"][PLUGIN_NAME]
        self._write_host_json(config_path, payload, original)
        sidecar_path.unlink()
        return {"status": "removed", "needs_user_action": False}

    def _codex_registration(self) -> dict[str, Any]:
        path = self.config.home / "adapters" / "codex.json"
        foreign, owned = self._foreign_or_owned_entry(path)
        if foreign is not None or not owned or owned.get("registration") != "official-codex-cli":
            # No receipt means no authority to invoke host mutations.
            config_path = _codex_home() / "config.toml"
            present = path.exists()
            if config_path.is_file():
                _assert_host_location(config_path)
                import tomllib
                data = tomllib.loads(config_path.read_text(encoding="utf-8-sig"))
                present = present or PLUGIN_NAME in data.get("mcp_servers", {})
            return {"status": "preserved" if present else "absent", "needs_user_action": present,
                    "reason": "An unproven old Codex connection was preserved." if present else "No old owned connection."}
        detected = self._detect_codex()
        if not detected["detected"]:
            return {"status": "preserved", "needs_user_action": True,
                    "reason": "Codex is unavailable; the old connection could not be verified."}
        state = self._codex_mcp_state(detected["executable"])
        if state["status"] == "error" or (state["status"] == "present" and not self._codex_sidecar_matches(owned, state["entry"])):
            return {"status": "preserved", "needs_user_action": True,
                    "reason": "The old Codex connection is unreadable or changed; it was preserved."}
        if state["status"] == "present":
            result = subprocess.run([detected["executable"], "mcp", "remove", PLUGIN_NAME], capture_output=True,
                                    text=True, encoding="utf-8", check=False, timeout=15)
            if result.returncode != 0 or self._codex_mcp_state(detected["executable"])["status"] != "absent":
                return {"status": "unverified", "needs_user_action": True,
                        "mutation_may_have_happened": True, "reason": "Old Codex connection removal was not verified."}
        path.unlink()
        return {"status": "removed", "needs_user_action": False}

    def migrate(self) -> dict[str, Any]:
        results = {}
        operations = {
            "cursor": lambda: self._json_registration("cursor", Path.home() / ".cursor" / "mcp.json", "official-cursor-user-json"),
            "claude-code": lambda: self._json_registration("claude-code", Path(os.environ.get("CLAUDE_CONFIG_DIR") or str(Path.home())) / ".claude.json", "official-claude-code-user"),
            "codex": self._codex_registration,
        }
        for name, operation in operations.items():
            try:
                if name == "claude-code" and os.environ.get("CLAUDE_CONFIG_DIR"):
                    # The old installer never registered custom Claude locations.
                    sidecar = self.config.home / "adapters" / "claude-code.json"
                    if sidecar.exists():
                        results[name] = {"status": "preserved", "needs_user_action": True,
                                         "reason": "Custom Claude location cannot prove the old user-scope connection."}
                        continue
                results[name] = operation()
            except (OSError, ValueError, FargoWorkError, subprocess.TimeoutExpired):
                results[name] = {"status": "preserved", "needs_user_action": True,
                                 "reason": "Old client configuration could not be safely verified; it was preserved."}
        # Old CodeBuddy receipts recorded a human-readable substring probe,
        # not a complete exact entry. That is insufficient proof for deletion.
        workbuddy = self.config.home / "adapters" / "workbuddy.json"
        present = workbuddy.exists() or workbuddy.is_symlink()
        results["workbuddy"] = {"status": "preserved" if present else "absent", "needs_user_action": present,
                                "reason": "Old WorkBuddy connection lacks exact ownership evidence; review it in the client." if present else "No old receipt."}
        return results


class ClientAdapters:
    """CLI and canonical Skill installation, with bounded legacy cleanup only."""

    def __init__(self, config: Config, registration_mode: str | None = None):
        self.config = config

    def selected(self, target: str = "cli") -> dict[str, Any]:
        if target != "cli":
            raise FargoWorkError("Only the official CLI is supported", code="invalid_target", exit_code=EXIT_USAGE)
        return {"cli": {"detected": True, "registered": False, "registration": "cli-no-mcp",
                        "trusted": "not_required", "needs_user_action": False,
                        "skill_path": str(_canonical_skill_path(self.config) / "SKILL.md")}}

    def register(self, target: str = "cli") -> dict[str, Any]:
        result = self.selected(target)
        migration = LegacyBridgeMigration(self.config).migrate()
        result["cli"]["legacy_migration"] = migration
        result["cli"]["needs_user_action"] = any(item.get("needs_user_action") for item in migration.values())
        return result

    def uninstall(self, target: str = "cli") -> dict[str, Any]:
        self.selected(target)
        migration = LegacyBridgeMigration(self.config).migrate()
        return {"cli": {"uninstalled": False, "needs_user_action": any(item.get("needs_user_action") for item in migration.values()),
                        "reason": "Credentials and employee preferences were preserved; use logout to clear this device login.",
                        "legacy_migration": migration}}


def _prepare_plugin(config: Config, source: Path | None = None) -> None:
    _assert_path_within(config.home, config.plugin_dir, label="plugin directory")
    source_value = os.environ.get("FARGOWORK_SOURCE_PLUGIN") if CLIENT_ENVIRONMENT == "development" else None
    source = source or (Path(source_value).expanduser() if source_value else None)
    if source and source.is_dir():
        _copy_tree_atomic(source, config.plugin_dir)
        return
    if config.plugin_dir.exists() or config.plugin_dir.is_symlink():
        _assert_safe_tree(config.plugin_dir, label="existing plugin")
    config.plugin_dir.mkdir(parents=True, exist_ok=True)
    marker = config.plugin_dir / ".fargowork-owner"
    if not marker.exists():
        marker.write_text(MARKER + "\n", encoding="utf-8")


def _doctor(config: Config, *, target: str = "cli") -> dict[str, Any]:
    adapters = ClientAdapters(config)
    clients = adapters.selected(target)
    plugin_ready = (config.plugin_dir / "plugin.json").is_file()
    if target == "cli":
        executable = config.home / "bin" / ("fargowork.exe" if platform.system() == "Windows" else "fargowork")
        plugin_ready = executable.is_file() and (_canonical_skill_path(config) / "SKILL.md").is_file()
    vault_present = False
    vault_error = None
    configured = bool(config.issuer and config.resource and config.resource_metadata_uri)
    if configured:
        try:
            vault_present = bool(config.secure_vault().get())
        except VaultError as exc:
            vault_error = exc.code
    checks = {
        "config": "ok" if configured else "missing_service_issuer",
        "environment": config.environment,
        "plugin": "ok" if plugin_ready else "missing",
        "secure_vault": "ok" if vault_error is None else "error",
        "refresh_credential": "present" if vault_present else "missing",
        "issuer": config.issuer,
        "resource": config.resource,
        "client_registration": {
            name: client.get("registration", "unknown") for name, client in clients.items()
        },
        "identity": "not_checked",
    }
    if "workbuddy" in clients:
        checks["workbuddy_trust"] = clients["workbuddy"]["trusted"]
    needs_action = (
        target == "manual"
        or not configured
        or not plugin_ready
        or vault_error is not None
        or not vault_present
        or _clients_need_action(clients, target=target)
    )
    payload = {
        "event": "doctor",
        "status": "needs_user_action" if needs_action else "ready",
        "target": target,
        "installed": plugin_ready,
        "connected": None,
        "identity_verified": False,
        "trusted": _client_trust(clients, target),
        "needs_user_action": needs_action,
        "checks": checks,
        "clients": clients,
        "compatibility": _compatibility_contract(),
        "skill_path": str(_canonical_skill_path(config) / "SKILL.md"),
    }
    if target == "cli":
        payload.update(connection_mode="cli", mcp_registration_required=False,
                       business_cli_available=plugin_ready, tool_capability="not_checked")
    return payload


class FargoWorkArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        if getattr(self, "_business_errors", False) or " tools" in self.prog:
            # argparse's normal error includes the rejected argument text. An
            # accidental token/JSON value must not be reflected into output.
            _emit_business_result(_business_error_payload(BusinessToolError(
                "tool_input_invalid", kind="input", exit_code=EXIT_USAGE)))
            self.exit(EXIT_USAGE)
        super().error(message)


def _build_parser() -> argparse.ArgumentParser:
    parser = FargoWorkArgumentParser(prog="fargowork", description="FargoWork employee business CLI")
    parser.add_argument("--output", choices=("human", "jsonl"), default="human")
    parser.add_argument("--version", action="version", version=VERSION)
    sub = parser.add_subparsers(dest="command", required=True)
    client_targets = ("cli",)
    default_target = "cli"
    registration_modes = ("auto", "official") if CLIENT_ENVIRONMENT == "employee" else ("auto", "official", "fixture")

    install = sub.add_parser("install", help="prepare the official CLI and employee Skill")
    install.add_argument("--target", choices=client_targets, default=default_target)
    if CLIENT_ENVIRONMENT == "development":
        install.add_argument("--source-plugin", type=Path)
    install.add_argument("--issuer")
    install.add_argument("--resource")
    install.add_argument("--resource-metadata-uri")
    install.add_argument("--redirect-uri")
    install.add_argument("--output", choices=("human", "jsonl"), default="human")
    install.add_argument("--attempt-id")

    for name in ("doctor", "repair", "uninstall", "status", "logout"):
        command = sub.add_parser(name, help=f"{name} FargoWork")
        command.add_argument("--target", choices=client_targets, default=default_target)
        command.add_argument("--output", choices=("human", "jsonl"), default="human")
        command.add_argument("--attempt-id")

    login = sub.add_parser("login", help="login with DingTalk-backed FargoWork OAuth")
    login.add_argument("--browser", choices=("auto", "always", "never"), default="auto")
    login.add_argument("--timeout", type=float, default=300.0)
    login.add_argument("--output", choices=("human", "jsonl"), default="human")
    login.add_argument("--attempt-id")

    update = sub.add_parser("update", help="check for a stable public Release")
    update.add_argument("--output", choices=("human", "jsonl"), default="human")
    update.add_argument("--attempt-id")

    version_command = sub.add_parser("version", help="print the FargoWork CLI version")
    version_command.add_argument("--output", choices=("human", "jsonl"), default="human")
    version_command.add_argument("--attempt-id")

    profile = sub.add_parser("profile", help="manage only the Server-verified current employee's local preferences")
    profile.add_argument("profile_action", choices=("show", "keep", "reset", "set"))
    profile.add_argument("--language", choices=("zh-CN", "en"))
    profile.add_argument("--response-style", choices=("concise", "balanced", "detailed"))
    profile.add_argument("--attempt-id")
    profile.add_argument("--output", choices=("human", "jsonl"), default="human")

    diagnostics = sub.add_parser("diagnostics", help="record or explicitly export only payload-free local diagnostics")
    diagnostics.add_argument("diagnostic_action", choices=("record", "export"))
    diagnostics.add_argument("--event", choices=sorted(EVENTS))
    diagnostics.add_argument("--phase", choices=sorted(PHASES))
    diagnostics.add_argument("--component", choices=("cli", "installer", "bootstrap", "launcher"), default="cli")
    diagnostics.add_argument("--outcome", choices=sorted(OUTCOMES))
    diagnostics.add_argument("--error-code")
    diagnostics.add_argument("--exit-code", type=int)
    diagnostics.add_argument("--duration-ms", type=int)
    diagnostics.add_argument("--attempt-id")
    diagnostics.add_argument("--days", type=int, default=7)
    diagnostics.add_argument("--destination", type=Path)
    diagnostics.add_argument("--output", choices=("human", "jsonl"), default="human")

    tools = sub.add_parser("tools", help="discover/call Server-published employee tools without host MCP registration")
    actions = tools.add_subparsers(dest="tools_action", required=True)
    for name in ("list", "call"):
        command = actions.add_parser(name, help="list public tools and input schemas" if name == "list" else "call one published tool once; submission requires prior user confirmation")
        if name == "call":
            command.add_argument("tool_name", help="exact public tool name returned by tools list")
            inputs = command.add_mutually_exclusive_group()
            inputs.add_argument("--input-file", type=Path, help="UTF-8 JSON arguments object from a regular file (max 64 KiB)")
            inputs.add_argument("--input-json", help="literal JSON arguments object; prefer stdin/input-file to avoid shell quoting")
            command.description = "Send one JSON arguments object. With no input flag read stdin; empty/interactive stdin means {}. No automatic login, business retry, endpoint override or Bearer parameter. A completed call is not submission success; inspect the public result."
        command.add_argument("--attempt-id", help="optional canonical UUID for payload-free diagnostics")
        command.add_argument("--output", choices=("jsonl", "json"), default="jsonl", help="one final JSON object; no progress on stdout")
    employee_attachments.add_parser(sub)
    return parser


def _config_from_install(config: Config, args: argparse.Namespace) -> Config:
    issuer_value = getattr(args, "issuer", None) or config.issuer
    if not issuer_value:
        raise FargoWorkError("service issuer is required; install with --issuer https://<service-domain>", code="configuration_required", exit_code=EXIT_USAGE)
    config.issuer = _validate_issuer(issuer_value)
    if CLIENT_ENVIRONMENT == "employee" and urlsplit(config.issuer).scheme != "https":
        parsed = urlsplit(config.issuer)
        if parsed.hostname not in {"127.0.0.1", "::1", "localhost"}:
            raise FargoWorkError("employee service issuer must use HTTPS", code="invalid_config", exit_code=EXIT_USAGE)
    expected_resource = f"{config.issuer}/mcp"
    expected_metadata = f"{config.issuer}/.well-known/oauth-protected-resource"
    supplied_resource = getattr(args, "resource", None)
    supplied_metadata = getattr(args, "resource_metadata_uri", None)
    if supplied_resource and supplied_resource.rstrip("/") != expected_resource:
        raise FargoWorkError("resource must be derived from the configured issuer", code="invalid_config", exit_code=EXIT_USAGE)
    if supplied_metadata and supplied_metadata.rstrip("/") != expected_metadata:
        raise FargoWorkError("metadata URI must be derived from the configured issuer", code="invalid_config", exit_code=EXIT_USAGE)
    config.resource = _validate_endpoint("resource", expected_resource)
    config.resource_metadata_uri = _validate_endpoint("resource_metadata_uri", expected_metadata)
    redirect_value = getattr(args, "redirect_uri", None) or DEFAULT_REDIRECT_URI
    if redirect_value != DEFAULT_REDIRECT_URI:
        raise FargoWorkError("redirect_uri must use the fixed FargoWork loopback callback", code="invalid_config", exit_code=EXIT_USAGE)
    config.redirect_uri = _validate_redirect(DEFAULT_REDIRECT_URI)
    config.environment = CLIENT_ENVIRONMENT
    return config


def _require_configured(config: Config) -> None:
    if not config.issuer or not config.resource or not config.resource_metadata_uri:
        raise FargoWorkError("FargoWork service is not configured; install with the service issuer supplied by your administrator", code="configuration_required", exit_code=EXIT_USAGE)


def _run_main(args: argparse.Namespace, holder: dict[str, Any]) -> int:
    output = getattr(args, "output", "human")
    try:
        config = Config.load()
        holder["config"] = config
        attempt = getattr(args, "attempt_id", None)
        try:
            log = DiagnosticLog.for_home(config.home, version=VERSION, command=args.command, component=getattr(args, "component", "cli"), attempt_id=attempt)
        except ValueError as exc:
            raise FargoWorkError("--attempt-id must be a canonical lowercase UUID", code="usage", exit_code=EXIT_USAGE) from exc
        holder["log"] = log
        holder["context_token"] = _DIAGNOSTIC_CONTEXT.set(log)
        _diagnostic_record(log, "cli_started", "start", outcome="started")
        if args.command == "attachments":
            _require_configured(config)
            _emit_business_result(employee_attachments.run_command(sys.modules[__name__], config, args))
            return EXIT_OK
        if args.command == "tools":
            _require_configured(config)
            arguments = _tool_arguments(args) if args.tools_action == "call" else None
            session = TokenSession(config)
            client = EmployeeToolsClient(session)
            if args.tools_action == "list":
                result = {"event": "tools_list", "status": "ready", "tools": client.discover(),
                          "server_info": client.server_info}
            else:
                coordinator = None
                context = None
                if args.tool_name in {"prepare_process_draft", "submit_process_draft"}:
                    coordinator = employee_attachments.AttachmentClient(sys.modules[__name__], config, business_session=session)
                    context = coordinator.before_tool(args.tool_name, arguments or {})
                try:
                    called = client.call(args.tool_name, arguments or {})
                except BaseException:
                    if coordinator is not None:
                        coordinator.tool_failed(args.tool_name, context)
                    raise
                result = {"event": "tool_result", "status": "completed", "tool": args.tool_name, "result": called}
                if coordinator is not None:
                    binding = coordinator.after_tool(args.tool_name, arguments or {}, called, context)
                    if binding is not None:
                        result["attachment_binding"] = binding
            result.update(identity_verified=True, identity=client.identity, tool_capability="available",
                          automatic_retry_allowed=False, **client.trace())
            _emit_business_result(result)
            return EXIT_OK
        if getattr(args, "codex_path", None):
            config.codex_path = _explicit_codex_path(args.codex_path)
        adapters = ClientAdapters(config, registration_mode=getattr(args, "registration_mode", "auto"))
        if args.command == "version":
            _emit_event(
                {
                    "event": "version",
                    "status": "ok",
                    "version": VERSION,
                    "compatibility": _compatibility_contract(),
                },
                output=output,
            )
            return EXIT_OK
        if args.command == "install":
            config = _config_from_install(config, args)
            config.save()
            _prepare_plugin(config, getattr(args, "source_plugin", None))
            _prepare_canonical_skill(config)
            clients = adapters.register(args.target)
            payload = _status_payload(
                config,
                clients=clients,
                target=args.target,
                connected=None,
            )
            payload["event"] = "installed"
            payload["message"] = (
                "Employee files prepared for the official business CLI; host MCP registration is not required."
                if args.target == "cli" else
                "Employee files prepared; the requested client was not registered."
                if _registration_failed(clients, args.target)
                else "Employee files prepared; sign in and complete any client approval shown in the status."
            )
            _emit_event(payload, output=output)
            return EXIT_NEEDS_ACTION if _registration_failed(clients, args.target) else EXIT_OK
        if args.command == "doctor":
            payload = _doctor(config, target=args.target)
            _emit_event(payload, output=output)
            return EXIT_NEEDS_ACTION if payload["status"] == "needs_user_action" else EXIT_OK
        if args.command == "repair":
            if getattr(args, "codex_path", None):
                config.save()
            _prepare_plugin(config)
            _prepare_canonical_skill(config)
            clients = adapters.register(args.target)
            payload = _status_payload(config, clients=clients, target=args.target, connected=None)
            payload["event"] = "repaired"
            _emit_event(payload, output=output)
            return EXIT_NEEDS_ACTION if _registration_failed(clients, args.target) else EXIT_OK
        if args.command == "uninstall":
            results = adapters.uninstall(args.target)
            if args.target == "all" and config.environment == "development" and not any(item.get("needs_user_action") for item in results.values()):
                try:
                    config.secure_vault().delete()
                except VaultError:
                    pass
                plugin_marker = config.plugin_dir / ".fargowork-owner"
                if plugin_marker.exists() or plugin_marker.is_symlink() or config.plugin_dir.is_symlink():
                    _remove_owned_tree(config.home, config.plugin_dir, label="FargoWork plugin")
            payload = {"event": "uninstalled", "installed": config.plugin_dir.exists(), "connected": False, "trusted": "unknown", "needs_user_action": any(item.get("needs_user_action") for item in results.values()), "clients": results}
            _emit_event(payload, output=output)
            return EXIT_OK
        if args.command == "login":
            _require_configured(config)
            session = TokenSession(config)
            auth_url, identity = session.login(browser=args.browser, timeout=args.timeout)
            payload = {"event": "logged_in", "connected": True, "identity_verified": True, "identity": identity, "issuer": config.issuer, "resource": config.resource}
            payload["profile"] = _current_profile(config, identity)
            payload["profile_pending_reset"] = payload["profile"].get("reset_prompt_pending") is True
            _emit_event(payload, output=output)
            return EXIT_OK
        if args.command == "logout":
            _require_configured(config)
            attachment_logout = None
            attachment_error = None
            if (config.home / "attachments").is_dir():
                try:
                    attachment_logout = employee_attachments.AttachmentClient(sys.modules[__name__], config).native.logout()
                except (FargoWorkError, employee_attachments.AttachmentError) as error:
                    attachment_error = error
            logout_status = TokenSession(config).logout()
            if attachment_error is not None:
                raise FargoWorkError("Business credentials cleared; attachment logout could not be fully confirmed.", code="logout_remote_unavailable", exit_code=EXIT_UNAVAILABLE) from None
            _emit_event({"event": "logged_out", "connected": False, "message": "current device credentials cleared",
                         "attachment_logout": attachment_logout, **logout_status}, output=output)
            return EXIT_OK
        if args.command == "status":
            _require_configured(config)
            session = TokenSession(config)
            try:
                identity = session.me()
                connected = True
            except FargoWorkError:
                identity = None
                connected = False
            clients = adapters.selected(args.target)
            payload = _status_payload(
                config,
                clients=clients,
                target=args.target,
                connected=connected,
                identity=identity,
            )
            if identity is not None:
                payload["profile"] = _current_profile(config, identity)
                payload["profile_pending_reset"] = payload["profile"].get("reset_prompt_pending") is True
            _emit_event(payload, output=output)
            return EXIT_NEEDS_ACTION if payload["needs_user_action"] else EXIT_OK
        if args.command == "update":
            payload = {"event": "update_unavailable", "status": "unavailable", "available": False, "reason": "No public FargoWork Release base URL is configured for this installation."}
            _emit_event(payload, output=output)
            return EXIT_UNAVAILABLE
        if args.command == "profile":
            _require_configured(config)
            if args.profile_action != "set" and (args.language or args.response_style):
                raise FargoWorkError("Preference flags are accepted only by profile set", code="usage", exit_code=EXIT_USAGE)
            identity = TokenSession(config).me()
            store = ProfileStore(config.home, VERSION)
            try:
                if args.profile_action == "show":
                    result = store.open_for_verified_identity(identity)
                elif args.profile_action in {"keep", "reset"}:
                    result = store.decide_reset(identity, reset=args.profile_action == "reset")
                else:
                    preferences = {}
                    if args.language:
                        preferences["language"] = args.language
                    if args.response_style:
                        preferences["response_style"] = args.response_style
                    if not preferences:
                        raise FargoWorkError("profile set requires a preference flag", code="usage", exit_code=EXIT_USAGE)
                    result = store.update_preferences(identity, preferences)
            except ProfileError as exc:
                raise FargoWorkError(str(exc), code=exc.code, exit_code=EXIT_NEEDS_ACTION) from exc
            _diagnostic_record(log, "profile_result", "profile", outcome="succeeded")
            _emit_event({"event": "profile", "status": "ready", "action": args.profile_action, "identity_verified": True, "identity": {key: identity[key] for key in ("corp_id", "userid") if key in identity}, "profile": result, "profile_pending_reset": result.get("reset_prompt_pending") is True}, output=output)
            return EXIT_OK
        if args.command == "diagnostics":
            if args.diagnostic_action == "record":
                if not args.event or not args.phase:
                    raise FargoWorkError("diagnostics record requires --event and --phase", code="usage", exit_code=EXIT_USAGE)
                recorded = log.record(args.event, args.phase, outcome=args.outcome, error_code=args.error_code, exit_code=args.exit_code, duration_ms=args.duration_ms)
                _emit_event({"event": "diagnostic_recorded" if recorded else "diagnostic_write_failed", "recorded": recorded}, output=output)
                return EXIT_OK if recorded else EXIT_UNAVAILABLE
            if args.destination is None:
                raise FargoWorkError("diagnostics export requires --destination NEW_FILE.zip", code="usage", exit_code=EXIT_USAGE)
            try:
                result = log.export(args.destination, days=args.days)
            except DiagnosticError as exc:
                raise FargoWorkError(str(exc), code="diagnostic_export_failed", exit_code=EXIT_UNAVAILABLE) from exc
            _diagnostic_record(log, "diagnostic_exported", "export", outcome="succeeded")
            _emit_event({"event": "diagnostics_exported", "status": "ready", **result}, output=output)
            return EXIT_OK
        raise FargoWorkError("unknown command", code="usage", exit_code=EXIT_USAGE)
    except employee_attachments.AttachmentError as exc:
        code = EXIT_NEEDS_ACTION if exc.kind == "auth" else EXIT_UNAVAILABLE if exc.kind in {"transport", "server"} else EXIT_USAGE
        holder["error_code"] = exc.code
        payload = {"event": "error", "status": "error", "error_code": exc.code, "error_kind": exc.kind,
                   "exit_code": code, "message": str(exc), "automatic_retry_allowed": False}
        if exc.kind == "auth":
            payload.update(next_action="attachment_login", login_args=["attachments", "login", "--browser", "always"])
        _emit_business_result(payload)
        return code
    except FargoWorkError as exc:
        holder["error_code"] = exc.code
        if args.command in {"tools", "attachments"}:
            _emit_business_result(_business_error_payload(exc, holder.get("config")))
            return exc.exit_code
        payload = {"event": "error", "status": "error", "error_code": safe_error_code(exc.code), "exit_code": exc.exit_code, "message": str(exc), "needs_user_action": exc.exit_code == EXIT_NEEDS_ACTION, "mutation_may_have_happened": exc.code == "registration_rollback_required" or bool(getattr(exc, "mutation_may_have_happened", False))}
        _emit_event(payload, output=output)
        return exc.exit_code
    except (OSError, ValueError, json.JSONDecodeError, subprocess.TimeoutExpired) as exc:
        holder["error_code"] = "runtime_error"
        if args.command in {"tools", "attachments"}:
            _emit_business_result(_business_error_payload(BusinessToolError("tool_transport_failed", kind="transport", exit_code=EXIT_UNAVAILABLE)))
            return EXIT_UNAVAILABLE
        payload = {"event": "error", "status": "error", "error_code": "runtime_error", "exit_code": EXIT_UNAVAILABLE, "message": "FargoWork could not complete the operation", "needs_user_action": False}
        _emit_event(payload, output=output)
        return EXIT_UNAVAILABLE


def main(argv: Iterable[str] | None = None) -> int:
    raw_args = list(argv) if argv is not None else sys.argv[1:]
    parser = _build_parser()
    parser._business_errors = any(name in raw_args[:3] for name in ("tools", "attachments"))
    args = parser.parse_args(raw_args)
    holder: dict[str, Any] = {}
    code = EXIT_UNAVAILABLE
    try:
        code = _run_main(args, holder)
        return code
    except KeyboardInterrupt:
        code = EXIT_NEEDS_ACTION
        holder["error_code"] = "login_cancelled"
        payload = {"event": "error", "error_code": "login_cancelled", "status": "cancelled", "message": "FargoWork operation cancelled. Check status before starting another login; no cleanup or business retry was performed."}
        if args.command == "tools":
            _emit_business_result(_business_error_payload(BusinessToolError("login_cancelled", kind="transport", exit_code=code)))
        else:
            _emit_event(payload, output=getattr(args, "output", "human"))
        return code
    finally:
        log = holder.get("log")
        if log is not None:
            fields = {"outcome": "succeeded" if code == EXIT_OK else "failed", "exit_code": code}
            if holder.get("error_code"):
                fields["error_code"] = holder["error_code"]
            _diagnostic_record(log, "cli_finished", "finish", **fields)
        if "context_token" in holder:
            _DIAGNOSTIC_CONTEXT.reset(holder["context_token"])


if __name__ == "__main__":
    raise SystemExit(main())
