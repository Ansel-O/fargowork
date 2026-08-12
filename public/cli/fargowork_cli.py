"""FargoWork native CLI and stdio bridge.

This module deliberately has no third-party runtime dependencies.  The
published executable is built from it with PyInstaller; the same executable
implements the interactive CLI and the MCP stdio bridge.

The bridge accepts the normal stdio JSON-RPC handshake used by agent hosts and
translates the local initialize request to FargoWork's modern
``server/discover`` request.  The upstream HTTP side is strictly the
2026-07-28 header contract and never falls back to legacy sessions.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import ctypes
import ctypes.wintypes
import hashlib
import hmac
import http.client
import ipaddress
import json
import os
import platform
import secrets
import shutil
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
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping
from urllib.parse import urlsplit


VERSION = "0.5.0-rc.1"
MCP_PROTOCOL_VERSION = "2026-07-28"
AGENT_PLUGINS_SPEC_VERSION = "1.0.0"
ACTION_RESULT_CONTRACT_VERSION = 1
MCP_SCOPE = "fargowork:mcp"
DEFAULT_ISSUER = "http://127.0.0.1:8081"
DEFAULT_RESOURCE = "http://127.0.0.1:8080/mcp"
DEFAULT_RESOURCE_METADATA_URI = "http://127.0.0.1:8080/.well-known/oauth-protected-resource"
DEFAULT_CLIENT_ID = "fargowork-cli"
DEFAULT_REDIRECT_URI = "http://127.0.0.1:37680/oauth/callback"
PLUGIN_NAME = "fargowork"
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


def _config_home() -> Path:
    override = os.environ.get("FARGOWORK_HOME")
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


def _plugin_home() -> Path:
    return Path(os.environ.get("FARGOWORK_PLUGIN_DIR", str(_config_home() / "plugin" / PLUGIN_NAME))).expanduser().resolve()


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
        values.update({key: env for key, env in {
            "issuer": os.environ.get("FARGOWORK_ISSUER"),
            "resource": os.environ.get("FARGOWORK_RESOURCE"),
            "resource_metadata_uri": os.environ.get("FARGOWORK_RESOURCE_METADATA_URI"),
            "client_id": os.environ.get("FARGOWORK_CLIENT_ID"),
            "redirect_uri": os.environ.get("FARGOWORK_REDIRECT_URI"),
            "plugin_dir": os.environ.get("FARGOWORK_PLUGIN_DIR"),
        }.items() if env})
        config = cls(
            home=home,
            issuer=_validate_endpoint("issuer", str(values.get("issuer", DEFAULT_ISSUER))),
            resource=_validate_endpoint("resource", str(values.get("resource", DEFAULT_RESOURCE))),
            resource_metadata_uri=_validate_endpoint("resource_metadata_uri", str(values.get("resource_metadata_uri", DEFAULT_RESOURCE_METADATA_URI))),
            client_id=str(values.get("client_id", DEFAULT_CLIENT_ID)),
            redirect_uri=_validate_redirect(str(values.get("redirect_uri", DEFAULT_REDIRECT_URI))),
            scope=MCP_SCOPE,
            plugin_dir=Path(str(values.get("plugin_dir", _plugin_home()))).expanduser().resolve(),
            version=str(values.get("version", VERSION)),
        )
        if not config.client_id or any(char.isspace() for char in config.client_id):
            raise FargoWorkError("client_id is invalid", code="invalid_config", exit_code=EXIT_USAGE)
        return config

    def save(self) -> None:
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
        }
        _atomic_write(self.home / "config.json", _json_bytes(payload))


class SecureVault:
    """OS-backed refresh-token storage; no plaintext fallback is allowed."""

    service = "fargowork.refresh-token.v1"

    def __init__(self, home: Path | None = None):
        self.home = home or _config_home()
        self._memory: str | None = None

    def get(self) -> str | None:
        if platform.system() == "Windows":
            path = self.home / "vault.dpapi"
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
                _atomic_write(self.home / "vault.dpapi", _dpapi_protect(token.encode("utf-8")))
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
                (self.home / "vault.dpapi").unlink(missing_ok=True)
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
        result = self._run_secret_tool(["lookup", "service", self.service, "account", "default"])
        if result.returncode == 1:
            return None
        if result.returncode != 0 or not result.stdout.strip():
            raise VaultError("Linux Secret Service lookup failed")
        return result.stdout.strip()

    def _linux_set(self, token: str) -> None:
        result = self._run_secret_tool(["store", "--label", "FargoWork refresh token", "service", self.service, "account", "default"], input_text=token + "\n")
        if result.returncode != 0:
            raise VaultError("Linux Secret Service refused the refresh token")

    def _linux_delete(self) -> None:
        result = self._run_secret_tool(["clear", "service", self.service, "account", "default"])
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
    vault: Any = field(default_factory=SecureVault)
    access_token: str | None = None
    access_expires_at: float = 0.0

    def _request_json(self, method: str, url: str, *, data: Mapping[str, str] | None = None, headers: Mapping[str, str] | None = None, timeout: float = 15.0) -> tuple[int, dict[str, Any]]:
        encoded = urllib.parse.urlencode(data or {}).encode("utf-8") if data is not None else None
        request = urllib.request.Request(url, data=encoded, method=method.upper())
        if data is not None:
            request.add_header("Content-Type", "application/x-www-form-urlencoded")
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read()
                status = int(response.status)
        except urllib.error.HTTPError as exc:
            body = exc.read()
            status = int(exc.code)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise FargoWorkError(f"FargoWork endpoint is unavailable: {urlsplit(url).netloc}", code="endpoint_unavailable", exit_code=EXIT_UNAVAILABLE) from exc
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

    def logout(self) -> None:
        raw_refresh = self.vault.get()
        raw_access = self.access_token
        remote_error: FargoWorkError | None = None
        if raw_access or raw_refresh:
            data = {"token": raw_access or raw_refresh or ""}
            try:
                status, _payload = self._request_json("POST", f"{self.config.issuer}/oauth/logout", data=data)
                if status >= 400:
                    remote_error = FargoWorkError("FargoWork remote logout could not be confirmed", code="logout_remote_failed", exit_code=EXIT_UNAVAILABLE)
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

    def me(self) -> dict[str, Any]:
        access = self.access()
        status, payload = self._request_json("GET", f"{self.config.issuer}/auth/me", headers={"Authorization": f"Bearer {access}"})
        if status == 401:
            self.access_token = None
            access = self.refresh()
            status, payload = self._request_json("GET", f"{self.config.issuer}/auth/me", headers={"Authorization": f"Bearer {access}"})
        if status >= 400:
            raise AuthRequired("FargoWork identity could not be verified; login is required")
        return {key: payload[key] for key in ("userid", "name", "corp_id", "scope") if key in payload}

    def login(self, *, browser: str = "auto", timeout: float = 300.0) -> tuple[str, dict[str, Any]]:
        verifier = _b64(secrets.token_bytes(32))
        challenge = _b64(hashlib.sha256(verifier.encode("ascii")).digest())
        state = _b64(secrets.token_bytes(32))
        callback = _CallbackWaiter(self.config.redirect_uri, expected_state=state, expected_issuer=self.config.issuer)
        query = urllib.parse.urlencode({
            "client_id": self.config.client_id,
            "redirect_uri": self.config.redirect_uri,
            "response_type": "code",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "resource": self.config.resource,
            "scope": self.config.scope,
            "state": state,
        })
        auth_url = f"{self.config.issuer}/oauth/authorize?{query}"
        callback.start()
        try:
            if browser != "never":
                try:
                    webbrowser.open(auth_url, new=2)
                except Exception:
                    if browser == "always":
                        raise FargoWorkError("browser could not be opened; use --browser never and open the displayed URL", code="browser_unavailable", exit_code=EXIT_NEEDS_ACTION)
            _emit_event({"event": "login_authorization_url", "url": auth_url}, force_json=True)
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
        return auth_url, self.me()


class _CallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        waiter: "_CallbackWaiter" = self.server.waiter  # type: ignore[attr-defined]
        parsed = urlsplit(self.path)
        if parsed.path != waiter.path:
            self.send_error(404)
            return
        params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        waiter.result = {key: values[-1] for key, values in params.items()}
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"FargoWork login callback received. You can close this window.")
        waiter.event.set()

    def log_message(self, _format: str, *_args: Any) -> None:
        return


class _CallbackWaiter:
    def __init__(self, redirect_uri: str, *, expected_state: str, expected_issuer: str):
        del expected_state, expected_issuer
        parsed = urlsplit(redirect_uri)
        self.path = parsed.path
        self.event = threading.Event()
        self.result: dict[str, str] = {}
        self.server: ThreadingHTTPServer | None = None
        self.thread: threading.Thread | None = None
        self.redirect_uri = redirect_uri

    def start(self) -> None:
        parsed = urlsplit(self.redirect_uri)
        host = parsed.hostname or ""
        if host not in {"127.0.0.1", "::1"} or parsed.port is None:
            raise FargoWorkError("OAuth redirect must use the fixed loopback callback", code="invalid_redirect", exit_code=EXIT_USAGE)
        try:
            self.server = ThreadingHTTPServer((host, parsed.port), _CallbackHandler)
        except OSError as exc:
            raise FargoWorkError("OAuth callback port 37680 is unavailable", code="callback_port_unavailable", exit_code=EXIT_NEEDS_ACTION) from exc
        self.server.daemon_threads = True
        self.server.waiter = self  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.server.serve_forever, name="fargowork-oauth-callback", daemon=True)
        self.thread.start()

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

    def request(self, message: Mapping[str, Any], *, method: str | None = None, retry_401: bool = True) -> dict[str, Any] | None:
        if not isinstance(message, Mapping):
            raise FargoWorkError("bridge input must be a JSON object", code="invalid_jsonrpc", exit_code=EXIT_PROTOCOL)
        wire_method = method or str(message.get("method") or "")
        if not wire_method:
            raise FargoWorkError("bridge JSON-RPC method is required", code="invalid_jsonrpc", exit_code=EXIT_PROTOCOL)
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
        }
        if method == "tools/call":
            params = message.get("params")
            tool_name = params.get("name") if isinstance(params, Mapping) else None
            if not isinstance(tool_name, str) or not tool_name.strip():
                raise FargoWorkError("tools/call requires a tool name", code="invalid_jsonrpc", exit_code=EXIT_PROTOCOL)
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
            return HTTPResult(response.status, {key.lower(): value for key, value in response.getheaders()}, raw)
        except (OSError, http.client.HTTPException) as exc:
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
        raise FargoWorkError("bridge JSON-RPC params must be an object", code="invalid_jsonrpc", exit_code=EXIT_PROTOCOL)
    params = dict(params_value or {})
    meta_value = params.get("_meta")
    if meta_value is not None and not isinstance(meta_value, Mapping):
        raise FargoWorkError("bridge JSON-RPC params._meta must be an object", code="invalid_jsonrpc", exit_code=EXIT_PROTOCOL)
    meta = dict(meta_value or {})
    meta.setdefault("io.modelcontextprotocol/protocolVersion", MCP_PROTOCOL_VERSION)
    meta.setdefault("io.modelcontextprotocol/clientInfo", {"name": "fargowork-stdio-client", "version": VERSION})
    meta.setdefault("io.modelcontextprotocol/clientCapabilities", {})
    return meta


def _with_modern_meta(message: Mapping[str, Any]) -> dict[str, Any]:
    translated = dict(message)
    meta = _modern_meta(message)
    params = dict(message.get("params") or {})
    params["_meta"] = meta
    translated["params"] = params
    return translated


def _translate_initialize(message: Mapping[str, Any]) -> dict[str, Any]:
    meta = _modern_meta(message)
    return {"jsonrpc": "2.0", "id": message.get("id"), "method": "server/discover", "params": {"_meta": meta}}


def _translate_capabilities(message: Mapping[str, Any]) -> dict[str, Any]:
    translated = _translate_initialize(message)
    translated["id"] = message.get("id")
    return translated


def _translate_discover_response(response: Mapping[str, Any]) -> dict[str, Any]:
    if "error" in response:
        return dict(response)
    result = dict(response.get("result") or {})
    capabilities = result.get("capabilities") or result.get("serverCapabilities") or {}
    server_info = result.get("serverInfo") or {"name": "fargowork", "version": VERSION}
    return {
        "jsonrpc": "2.0",
        "id": response.get("id"),
        "result": {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": capabilities,
            "serverInfo": server_info,
        },
    }


def _bridge_error(message: Mapping[str, Any] | None, error: FargoWorkError) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": message.get("id") if isinstance(message, Mapping) else None,
        "error": {
            "code": -32001 if error.code in {"auth_required", "secure_storage_unavailable"} else -32002,
            "message": str(error),
            "data": {"code": error.code},
        },
    }


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


def run_bridge(session: TokenSession, *, input_stream: Any = None, output_stream: Any = None) -> int:
    input_stream = input_stream or sys.stdin
    output_stream = output_stream or sys.stdout
    _configure_utf8_stream(input_stream)
    _configure_utf8_stream(output_stream)
    client = MCPHTTPClient(session)
    for line in input_stream:
        if not line.strip():
            continue
        message: dict[str, Any] | None = None
        try:
            loaded = json.loads(line)
            if not isinstance(loaded, dict):
                raise FargoWorkError("bridge JSON-RPC input must be an object", code="invalid_jsonrpc", exit_code=EXIT_PROTOCOL)
            message = loaded
            method = str(message.get("method") or "")
            if method in {"notifications/initialized", "notifications/cancelled", "$/cancelRequest"}:
                # The upstream server is stateless.  Local lifecycle and
                # cancellation notifications are consumed without inventing a
                # session or writing a protocol response.
                continue
            upstream = _translate_initialize(message) if method == "initialize" else (_translate_capabilities(message) if method == "capabilities" else _with_modern_meta(message))
            response = client.request(upstream, method=str(upstream.get("method") or method))
            if response is None or "id" not in message:
                continue
            if method == "initialize" and response is not None:
                response = _translate_discover_response(response)
                response["id"] = message.get("id")
            elif method == "capabilities" and response is not None:
                translated = _translate_discover_response(response)
                response = {"jsonrpc": "2.0", "id": message.get("id"), "result": translated.get("result", {}).get("capabilities", {})}
            elif response is not None:
                response["id"] = message.get("id")
            if response is not None:
                output_stream.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
                output_stream.flush()
        except (json.JSONDecodeError, binascii.Error) as exc:
            error = FargoWorkError("bridge input is not valid JSON", code="invalid_jsonrpc", exit_code=EXIT_PROTOCOL)
            output_stream.write(json.dumps(_bridge_error(message, error), separators=(",", ":")) + "\n")
            output_stream.flush()
            return error.exit_code
        except FargoWorkError as exc:
            if message is not None and "id" in message:
                output_stream.write(json.dumps(_bridge_error(message, exc), separators=(",", ":")) + "\n")
                output_stream.flush()
            return exc.exit_code
        except Exception:
            error = FargoWorkError("bridge failed without exposing internal details", code="bridge_failed", exit_code=EXIT_PROTOCOL)
            if message is not None and "id" in message:
                output_stream.write(json.dumps(_bridge_error(message, error), separators=(",", ":")) + "\n")
                output_stream.flush()
            return error.exit_code
    return EXIT_OK


def _emit_event(payload: Mapping[str, Any], *, force_json: bool = False, output: str = "human") -> None:
    if force_json or output == "jsonl":
        print(json.dumps(_safe_no_secret(dict(payload)), ensure_ascii=False, separators=(",", ":")), flush=True)
        return
    event = payload.get("event") or payload.get("status") or "result"
    details = payload.get("message") or payload.get("reason") or ""
    print(f"{event}: {details}".rstrip(": "), flush=True)
    manual = payload.get("manual_mcp_registration")
    if isinstance(manual, Mapping):
        print(
            "manual_mcp_registration: open your client's custom MCP/connector "
            "settings, choose stdio, and use this configuration:",
            flush=True,
        )
        print(
            json.dumps(manual.get("config") or {}, ensure_ascii=False, indent=2),
            flush=True,
        )


def _compatibility_contract() -> dict[str, Any]:
    return {
        "mcp_protocol_versions": [MCP_PROTOCOL_VERSION],
        "agent_plugins_spec": AGENT_PLUGINS_SPEC_VERSION,
        "action_result_contract": ACTION_RESULT_CONTRACT_VERSION,
    }


def _manual_mcp_registration(config: Config) -> dict[str, Any]:
    executable = config.plugin_dir / "bin" / (
        "fargowork.exe" if platform.system() == "Windows" else "fargowork"
    )
    server = {
        "type": "stdio",
        "command": str(executable),
        "args": ["bridge"],
    }
    return {
        "name": PLUGIN_NAME,
        "transport": "stdio",
        "command": server["command"],
        "args": list(server["args"]),
        "config": {"mcpServers": {PLUGIN_NAME: server}},
        "instructions": (
            "Open the client's custom MCP/connector settings, choose stdio, "
            "and paste or map the provided command and args."
        ),
    }


def _client_trust(clients: Mapping[str, Mapping[str, Any]], target: str) -> bool | str:
    if target != "all":
        return clients.get(target, {}).get("trusted", "unknown")
    return clients.get("workbuddy", {}).get("trusted", "unknown")


def _clients_need_action(
    clients: Mapping[str, Mapping[str, Any]], *, target: str
) -> bool:
    return any(
        bool(client.get("needs_user_action"))
        and (target != "all" or bool(client.get("detected")) or bool(client.get("registered")))
        for client in clients.values()
    )


def _status_payload(
    config: Config,
    *,
    clients: dict[str, Any],
    target: str = "all",
    connected: bool | None = None,
    identity: dict[str, Any] | None = None,
) -> dict[str, Any]:
    plugin_ready = (config.plugin_dir / "plugin.json").is_file() and (config.plugin_dir / "mcp.json").is_file()
    needs_action = (
        not plugin_ready
        or connected is False
        or _clients_need_action(clients, target=target)
    )
    payload = {
        "status": "ok" if plugin_ready else "not_installed",
        "target": target,
        "version": VERSION,
        "compatibility": _compatibility_contract(),
        "installed": plugin_ready,
        "connected": connected,
        "trusted": _client_trust(clients, target),
        "needs_user_action": needs_action,
        "config": {
            "home": str(config.home),
            "plugin_dir": str(config.plugin_dir),
            "issuer": config.issuer,
            "resource": config.resource,
            "redirect_uri": config.redirect_uri,
            "client_id": config.client_id,
            "scope": config.scope,
        },
        "clients": clients,
        "manual_mcp_registration": _manual_mcp_registration(config),
    }
    if identity:
        payload["identity"] = identity
    return payload


def _detect_command(*names: str) -> dict[str, Any]:
    for name in names:
        path = shutil.which(name)
        if path:
            return {"detected": True, "executable": path}
    return {"detected": False, "executable": None}


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


def _copy_tree_atomic(source: Path, target: Path) -> None:
    if not source.is_dir():
        raise FargoWorkError(f"plugin source directory is missing: {source}", code="plugin_missing", exit_code=EXIT_UNAVAILABLE)
    _assert_safe_tree(source, label="plugin source")
    if target.exists() or target.is_symlink():
        _assert_safe_tree(target, label="existing plugin")
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = Path(tempfile.mkdtemp(prefix=f".{target.name}-", dir=str(target.parent)))
    backup = target.with_name(target.name + ".backup")
    if backup.exists() or backup.is_symlink():
        _assert_safe_tree(backup, label="plugin backup")
    try:
        shutil.copytree(source, temp / target.name, dirs_exist_ok=True)
        (temp / target.name / ".fargowork-owner").write_text(MARKER + "\n", encoding="utf-8")
        if target.exists() and not _owned_path(target):
            raise FargoWorkError(f"refusing to overwrite a non-FargoWork plugin directory: {target}", code="ownership_conflict", exit_code=EXIT_NEEDS_ACTION)
        if target.exists():
            if backup.exists():
                shutil.rmtree(backup)
            os.replace(target, backup)
        os.replace(temp / target.name, target)
    except Exception:
        if target.exists() and backup.exists() and not _is_link_or_reparse(backup):
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


def _adopt_identical_tree(source: Path, target: Path) -> bool:
    """Adopt an exact prior FargoWork copy without overwriting foreign content."""
    if not target.is_dir() or _owned_path(target):
        return _owned_path(target)
    if _tree_hashes(source) != _tree_hashes(target):
        return False
    (target / ".fargowork-owner").write_text(MARKER + "\n", encoding="utf-8")
    return True


class ClientAdapters:
    def __init__(self, config: Config, registration_mode: str = "fixture"):
        self.config = config
        self.registration_mode = os.environ.get("FARGOWORK_CLIENT_REGISTRATION_MODE", registration_mode)
        if self.registration_mode not in {"auto", "official", "fixture"}:
            raise FargoWorkError("client registration mode must be auto, official, or fixture", code="invalid_registration_mode", exit_code=EXIT_USAGE)

    def _bridge_command(self) -> str:
        return str(self.config.plugin_dir / "bin" / ("fargowork.cmd" if platform.system() == "Windows" else "fargowork"))

    def _codex_skill_source(self) -> Path:
        return self.config.plugin_dir / "skills" / PLUGIN_NAME

    def _codex_skill_path(self) -> Path:
        return _codex_home() / "skills" / PLUGIN_NAME

    def _install_codex_skill(self) -> dict[str, Any]:
        source = self._codex_skill_source()
        target = self._codex_skill_path()
        _assert_path_within(self.config.plugin_dir, source, label="Codex Skill source")
        _assert_path_within(_codex_home(), target, label="Codex Skill destination")
        if not source.joinpath("SKILL.md").is_file():
            raise FargoWorkError(
                "the FargoWork Agent Plugin does not contain its core Skill",
                code="skill_missing",
                exit_code=EXIT_UNAVAILABLE,
            )
        if target.exists() and not _owned_path(target) and not _adopt_identical_tree(source, target):
            raise FargoWorkError(
                f"refusing to overwrite an existing non-FargoWork Codex Skill: {target}",
                code="ownership_conflict",
                exit_code=EXIT_NEEDS_ACTION,
            )
        _copy_tree_atomic(source, target)
        return {"installed": True, "managed": True, "path": str(target)}

    def _codex_skill_status(self) -> dict[str, Any]:
        target = self._codex_skill_path()
        installed = target.joinpath("SKILL.md").is_file()
        managed = installed and _owned_path(target)
        return {
            "installed": installed,
            "managed": managed,
            "path": str(target),
            "status": "ready" if managed else ("unmanaged" if installed else "missing"),
        }

    def _codebuddy_probe(self, executable: str) -> dict[str, Any]:
        result = subprocess.run([executable, "mcp", "get", PLUGIN_NAME], capture_output=True, text=True, check=False)
        text = f"{result.stdout}\n{result.stderr}".lower()
        if "not found in any scope" in text:
            return {"status": "absent", "returncode": result.returncode, "text": text}
        if result.returncode != 0:
            return {"status": "error", "returncode": result.returncode, "text": text}
        return {"status": "present", "returncode": result.returncode, "text": text}

    def _codebuddy_command(self, executable: str) -> list[str]:
        return [executable, "mcp", "add", PLUGIN_NAME, "-s", "user", "-t", "stdio", "--", self._bridge_command(), "bridge"]

    def _codebuddy_matches(self, probe: Mapping[str, Any]) -> bool:
        command = self._bridge_command().replace("\\", "/").lower()
        text = str(probe.get("text") or "").replace("\\", "/").lower()
        return probe.get("status") == "present" and command in text and "bridge" in text

    def workbuddy(self) -> dict[str, Any]:
        detected = _detect_command("codebuddy")
        path = self.config.home / "adapters" / "workbuddy.json"
        base = {
            **detected,
            "registered": False,
            "trusted": "unknown",
            "needs_user_action": bool(detected["detected"]),
            "registration": "not_detected" if not detected["detected"] else "not_registered",
            "trust_path": "WorkBuddy UI: Settings -> Connectors -> Custom Connector (or Settings -> MCP), trust and enable the FargoWork user-scope MCP entry.",
            "plugin_dir": str(self.config.plugin_dir),
            "config_path": str(path),
            "official_cli_registration": bool(detected["detected"]),
            "official_command": self._codebuddy_command(detected["executable"]) if detected["detected"] else None,
        }
        _foreign, owned = self._foreign_or_owned_entry(path)
        if self.registration_mode == "fixture" and owned and owned.get("registration") == "fargowork-owned-fixture":
            return {**base, "registered": True, "trusted": "unknown", "needs_user_action": True, "registration": "fargowork-owned-fixture", "reason": "fixture registration is installed; real CodeBuddy registration is disabled in fixture mode"}
        if not detected["detected"]:
            base["reason"] = "CodeBuddy is not installed; skipped."
            return base
        loaded = owned or {}
        probe = self._codebuddy_probe(detected["executable"])
        if probe["status"] == "error":
            return {**base, "registration": "official-cli-error", "reason": "CodeBuddy MCP status could not be read; retry doctor."}
        if probe["status"] == "present":
            if loaded.get("registration") in {"official-codebuddy-user", "fargowork-owned-fixture"} and self._codebuddy_matches(probe):
                return {**base, "registered": True, "needs_user_action": True, "registration": loaded.get("registration"), "reason": "MCP is registered; WorkBuddy UI trust/enable is still required."}
            return {**base, "registration": "conflict", "reason": "CodeBuddy already has a FargoWork-named MCP entry not owned by this installation; it was preserved."}
        if loaded.get("registration") == "official-codebuddy-user":
            return {**base, "registration": "registration_missing", "reason": "The owned CodeBuddy user-scope entry is missing; run fargowork repair."}
        return {**base, "registration": "not_registered", "reason": "CodeBuddy is installed but the FargoWork user-scope MCP entry is not registered."}

    def _register_workbuddy_official(self, path: Path) -> dict[str, Any]:
        detected = _detect_command("codebuddy")
        if not detected["detected"]:
            return self.workbuddy()
        foreign, owned = self._foreign_or_owned_entry(path)
        probe = self._codebuddy_probe(detected["executable"])
        if probe["status"] == "error":
            return {**self.workbuddy(), "registration": "official-cli-error", "reason": "CodeBuddy MCP status could not be read; no registration was attempted."}
        if probe["status"] == "present":
            if foreign is not None:
                return {**self.workbuddy(), "registration": "conflict", "reason": "CodeBuddy already has a FargoWork-named MCP entry not owned by this installation; it was preserved."}
            if owned and owned.get("registration") == "official-codebuddy-user" and self._codebuddy_matches(probe):
                return self.workbuddy()
            return {**self.workbuddy(), "registration": "conflict", "reason": "CodeBuddy already has a FargoWork-named MCP entry not owned by this installation; it was preserved."}
        command = self._codebuddy_command(detected["executable"])
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            return {**self.workbuddy(), "registration": "official-cli-failed", "reason": "CodeBuddy user-scope MCP registration failed; retry repair."}
        verify = self._codebuddy_probe(detected["executable"])
        if not self._codebuddy_matches(verify):
            return {**self.workbuddy(), "registration": "registration_unverified", "reason": "CodeBuddy did not report the expected user-scope FargoWork command after registration; ownership was not recorded."}
        _atomic_write(path, _json_bytes({**self._fixture_payload(), "registration": "official-codebuddy-user", "scope": "user", "official_command": command}))
        return self.workbuddy()

    def codex(self) -> dict[str, Any]:
        detected = _detect_command("codex")
        path = self.config.home / "adapters" / "codex.json"
        registered = _owned_path(path)
        entry: dict[str, Any] = {}
        if registered:
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    entry = loaded
            except (OSError, ValueError, json.JSONDecodeError):
                registered = False
        official = registered and entry.get("registration") == "official-codex-cli"
        skill = self._codex_skill_status()
        return {
            **detected,
            "registered": registered,
            "trusted": True if official and skill["managed"] else ("unknown" if registered else False),
            "needs_user_action": not official or not skill["managed"],
            "config_path": str(path),
            "registration": entry.get("registration", "not_registered"),
            "skill": skill,
            "official_command": [detected["executable"], "mcp", "add", PLUGIN_NAME, "--", self._bridge_command(), "bridge"] if detected["detected"] else None,
        }

    def cursor(self) -> dict[str, Any]:
        detected = _detect_command("cursor")
        path = self.config.home / "adapters" / "cursor.json"
        registered = _owned_path(path)
        entry: dict[str, Any] = {}
        if registered:
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    entry = loaded
            except (OSError, ValueError, json.JSONDecodeError):
                registered = False
        official = registered and entry.get("registration") == "official-cursor-cli"
        return {
            **detected,
            "registered": registered,
            "trusted": True if official else ("unknown" if registered else False),
            "needs_user_action": not official,
            "config_path": str(path),
            "registration": entry.get("registration", "not_registered"),
            "official_command": [detected["executable"], "--add-mcp", json.dumps({"name": PLUGIN_NAME, "command": self._bridge_command(), "args": ["bridge"]}, separators=(",", ":"))] if detected["detected"] else None,
        }

    def all(self) -> dict[str, Any]:
        return {"workbuddy": self.workbuddy(), "codex": self.codex(), "cursor": self.cursor()}

    def selected(self, target: str) -> dict[str, Any]:
        if target == "all":
            return self.all()
        return {target: getattr(self, target)()}

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

    def _fixture_payload(self) -> dict[str, Any]:
        return {
            "owner": MARKER,
            "name": PLUGIN_NAME,
            "command": self._bridge_command(),
            "args": ["bridge"],
            "resource": self.config.resource,
            "managed_by": "fargowork install --registration-mode fixture",
            "registration": "fargowork-owned-fixture",
        }

    def _register_codex_official(self, path: Path) -> dict[str, Any]:
        detected = _detect_command("codex")
        if not detected["detected"]:
            return {**self.codex(), "registration": "not_detected", "needs_user_action": False, "reason": "Codex is not installed; skipped."}
        self._install_codex_skill()
        foreign, owned = self._foreign_or_owned_entry(path)
        if foreign is not None:
            return {**self.codex(), "registered": False, "trusted": False, "needs_user_action": True, "reason": "existing non-FargoWork entry preserved"}
        if owned and owned.get("registration") == "official-codex-cli":
            return {**self.codex(), "registered": True, "trusted": True, "needs_user_action": False}
        probe = subprocess.run([detected["executable"], "mcp", "get", PLUGIN_NAME], capture_output=True, text=True, check=False)
        if probe.returncode == 0:
            return {**self.codex(), "registered": False, "trusted": False, "needs_user_action": True, "reason": "Codex already has a FargoWork-named entry not owned by this installer; preserved."}
        command = [detected["executable"], "mcp", "add", PLUGIN_NAME, "--", self._bridge_command(), "bridge"]
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            return {**self.codex(), "registered": False, "trusted": False, "needs_user_action": True, "reason": "Codex official registration command failed; inspect Codex configuration and retry."}
        _atomic_write(path, _json_bytes({**self._fixture_payload(), "registration": "official-codex-cli", "official_command": command}))
        return {**self.codex(), "registered": True, "trusted": True, "needs_user_action": False}

    def _register_cursor_official(self, path: Path) -> dict[str, Any]:
        detected = _detect_command("cursor")
        if not detected["detected"]:
            return {**self.cursor(), "registration": "not_detected", "needs_user_action": False, "reason": "Cursor is not installed; skipped."}
        foreign, owned = self._foreign_or_owned_entry(path)
        if foreign is not None:
            return {**self.cursor(), "registered": False, "trusted": False, "needs_user_action": True, "reason": "existing non-FargoWork entry preserved"}
        if owned and owned.get("registration") == "official-cursor-cli":
            return {**self.cursor(), "registered": True, "trusted": True, "needs_user_action": False}
        return {**self.cursor(), "registered": False, "trusted": False, "needs_user_action": True, "registration": "official-cli-detect-only", "reason": "Cursor official help exposes --add-mcp but no supported remove/list contract was verified; no guessed config write was performed."}

    def register(self, target: str) -> dict[str, Any]:
        self.config.home.joinpath("adapters").mkdir(parents=True, exist_ok=True)
        results = {}
        targets = ["workbuddy", "codex", "cursor"] if target == "all" else [target]
        for name in targets:
            if name == "workbuddy":
                path = self.config.home / "adapters" / "workbuddy.json"
                if self.registration_mode in {"auto", "official"}:
                    results[name] = self._register_workbuddy_official(path)
                    continue
                foreign, _owned = self._foreign_or_owned_entry(path)
                if foreign is not None:
                    results[name] = {**self.workbuddy(), "registered": False, "needs_user_action": True, "registration": "conflict", "reason": "existing non-FargoWork entry preserved"}
                    continue
                _atomic_write(path, _json_bytes(self._fixture_payload()))
                results[name] = {**self.workbuddy(), "registered": True, "trusted": "unknown", "needs_user_action": True, "registration": "fargowork-owned-fixture", "reason": "fixture registration prepared; real CodeBuddy registration is disabled in fixture mode"}
                continue
            path = self.config.home / "adapters" / f"{name}.json"
            if self.registration_mode in {"auto", "official"}:
                results[name] = self._register_codex_official(path) if name == "codex" else self._register_cursor_official(path)
                continue
            if name == "codex":
                self._install_codex_skill()
            foreign, _owned = self._foreign_or_owned_entry(path)
            if foreign is not None:
                results[name] = {**getattr(self, name)(), "registered": False, "needs_user_action": True, "reason": "existing non-FargoWork entry preserved"}
                continue
            _atomic_write(path, _json_bytes(self._fixture_payload()))
            results[name] = {**getattr(self, name)(), "registered": True, "trusted": "unknown", "needs_user_action": True}
        return results

    def uninstall(self, target: str) -> dict[str, Any]:
        targets = ["workbuddy", "codex", "cursor"] if target == "all" else [target]
        results = {}
        for name in targets:
            if name == "workbuddy":
                path = self.config.home / "adapters" / "workbuddy.json"
                foreign, owned = self._foreign_or_owned_entry(path)
                if foreign is not None:
                    results[name] = {**self.workbuddy(), "uninstalled": False, "needs_user_action": True, "reason": "existing non-FargoWork CodeBuddy ownership was preserved"}
                    continue
                if owned is None:
                    results[name] = {**self.workbuddy(), "uninstalled": False, "needs_user_action": True, "reason": "no FargoWork-owned WorkBuddy registration; trust/enable state remains UI-owned"}
                    continue
                if owned.get("registration") == "official-codebuddy-user":
                    executable = _detect_command("codebuddy")["executable"]
                    if not executable:
                        results[name] = {**self.workbuddy(), "uninstalled": False, "needs_user_action": True, "reason": "CodeBuddy is unavailable; remove the FargoWork user-scope entry with CodeBuddy and retry."}
                        continue
                    probe = self._codebuddy_probe(executable)
                    if probe["status"] == "error":
                        results[name] = {**self.workbuddy(), "uninstalled": False, "needs_user_action": True, "reason": "CodeBuddy MCP status could not be read; the owned registration was preserved."}
                        continue
                    if probe["status"] == "present" and not self._codebuddy_matches(probe):
                        results[name] = {**self.workbuddy(), "uninstalled": False, "needs_user_action": True, "reason": "CodeBuddy FargoWork entry no longer matches the owned launcher; it was preserved."}
                        continue
                    if probe["status"] == "present":
                        result = subprocess.run([executable, "mcp", "remove", "-s", "user", PLUGIN_NAME], capture_output=True, text=True, check=False)
                        if result.returncode != 0:
                            results[name] = {**self.workbuddy(), "uninstalled": False, "needs_user_action": True, "reason": "CodeBuddy user-scope removal failed; remove FargoWork in CodeBuddy and retry."}
                            continue
                path.unlink()
                results[name] = {**self.workbuddy(), "uninstalled": True, "needs_user_action": True, "reason": "FargoWork registration removed; WorkBuddy UI trust/enable state may still need manual cleanup."}
                continue
            path = self.config.home / "adapters" / f"{name}.json"
            if path.exists() and _owned_path(path):
                entry = {}
                try:
                    loaded = json.loads(path.read_text(encoding="utf-8"))
                    if isinstance(loaded, dict):
                        entry = loaded
                except (OSError, ValueError, json.JSONDecodeError):
                    pass
                if entry.get("registration") == "official-codex-cli" and name == "codex":
                    executable = _detect_command("codex")["executable"]
                    if executable:
                        result = subprocess.run([executable, "mcp", "remove", PLUGIN_NAME], capture_output=True, text=True, check=False)
                        if result.returncode != 0:
                            results[name] = {"uninstalled": False, "needs_user_action": True, "reason": "Codex official removal failed; remove FargoWork from Codex and retry."}
                            continue
                path.unlink()
                if name == "codex":
                    skill_path = self._codex_skill_path()
                    if skill_path.exists() or skill_path.is_symlink():
                        _remove_owned_tree(_codex_home(), skill_path, label="Codex Skill")
                results[name] = {"uninstalled": True, "needs_user_action": False}
            else:
                if name == "codex":
                    skill_path = self._codex_skill_path()
                    if skill_path.exists() or skill_path.is_symlink():
                        _remove_owned_tree(_codex_home(), skill_path, label="Codex Skill")
                        results[name] = {
                            "uninstalled": True,
                            "needs_user_action": False,
                            "reason": "FargoWork-owned Codex Skill removed; no owned MCP entry existed",
                        }
                        continue
                results[name] = {"uninstalled": False, "needs_user_action": False, "reason": "no FargoWork-owned entry"}
        return results


def _prepare_plugin(config: Config, source: Path | None = None) -> None:
    _assert_path_within(config.home, config.plugin_dir, label="plugin directory")
    source_value = os.environ.get("FARGOWORK_SOURCE_PLUGIN")
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


def _doctor(config: Config, *, target: str = "all") -> dict[str, Any]:
    adapters = ClientAdapters(config)
    clients = adapters.selected(target)
    plugin_ready = (config.plugin_dir / "plugin.json").is_file() and (config.plugin_dir / "mcp.json").is_file()
    vault_present = False
    vault_error = None
    try:
        vault_present = bool(SecureVault(config.home).get())
    except VaultError as exc:
        vault_error = exc.code
    checks = {
        "config": "ok",
        "plugin": "ok" if plugin_ready else "missing",
        "secure_vault": "ok" if vault_error is None else "error",
        "refresh_credential": "present" if vault_present else "missing",
        "issuer": config.issuer,
        "resource": config.resource,
        "client_registration": {
            name: client.get("registration", "unknown") for name, client in clients.items()
        },
    }
    if "workbuddy" in clients:
        checks["workbuddy_trust"] = clients["workbuddy"]["trusted"]
    needs_action = (
        not plugin_ready
        or vault_error is not None
        or not vault_present
        or _clients_need_action(clients, target=target)
    )
    return {
        "status": "needs_user_action" if needs_action else "ready",
        "target": target,
        "installed": plugin_ready,
        "connected": vault_present,
        "trusted": _client_trust(clients, target),
        "needs_user_action": needs_action,
        "checks": checks,
        "clients": clients,
        "compatibility": _compatibility_contract(),
        "manual_mcp_registration": _manual_mcp_registration(config),
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="fargowork", description="FargoWork CLI and MCP bridge")
    parser.add_argument("--output", choices=("human", "jsonl"), default="human")
    parser.add_argument("--version", action="version", version=VERSION)
    sub = parser.add_subparsers(dest="command", required=True)

    install = sub.add_parser("install", help="install the plugin and register detected clients")
    install.add_argument("--target", choices=("all", "workbuddy", "codex", "cursor"), default="all")
    install.add_argument("--source-plugin", type=Path)
    install.add_argument("--issuer")
    install.add_argument("--resource")
    install.add_argument("--resource-metadata-uri")
    install.add_argument("--redirect-uri")
    install.add_argument("--registration-mode", choices=("auto", "official", "fixture"), default="auto")
    install.add_argument("--output", choices=("human", "jsonl"), default="human")

    for name in ("doctor", "repair", "uninstall", "status", "logout"):
        command = sub.add_parser(name, help=f"{name} FargoWork")
        command.add_argument("--target", choices=("all", "workbuddy", "codex", "cursor"), default="all")
        if name == "repair":
            command.add_argument("--registration-mode", choices=("auto", "official", "fixture"), default="auto")
        command.add_argument("--output", choices=("human", "jsonl"), default="human")

    login = sub.add_parser("login", help="login with DingTalk-backed FargoWork OAuth")
    login.add_argument("--browser", choices=("auto", "always", "never"), default="auto")
    login.add_argument("--timeout", type=float, default=300.0)
    login.add_argument("--output", choices=("human", "jsonl"), default="human")

    update = sub.add_parser("update", help="check for a stable public Release")
    update.add_argument("--output", choices=("human", "jsonl"), default="human")

    version_command = sub.add_parser("version", help="print the FargoWork CLI version")
    version_command.add_argument("--output", choices=("human", "jsonl"), default="human")

    bridge = sub.add_parser("bridge", help="proxy MCP JSON-RPC over stdio")
    bridge.add_argument("--output", choices=("human", "jsonl"), default="jsonl")
    return parser


def _config_from_install(config: Config, args: argparse.Namespace) -> Config:
    for attribute, argument in (("issuer", "issuer"), ("resource", "resource"), ("resource_metadata_uri", "resource_metadata_uri"), ("redirect_uri", "redirect_uri")):
        value = getattr(args, argument, None)
        if value:
            setattr(config, attribute, value)
    config.issuer = _validate_endpoint("issuer", config.issuer)
    config.resource = _validate_endpoint("resource", config.resource)
    config.resource_metadata_uri = _validate_endpoint("resource_metadata_uri", config.resource_metadata_uri)
    config.redirect_uri = _validate_redirect(config.redirect_uri)
    return config


def main(argv: Iterable[str] | None = None) -> int:
    args = _build_parser().parse_args(list(argv) if argv is not None else None)
    output = getattr(args, "output", "human")
    try:
        config = Config.load()
        adapters = ClientAdapters(config, registration_mode=getattr(args, "registration_mode", "fixture"))
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
            _prepare_plugin(config, args.source_plugin)
            clients = adapters.register(args.target)
            payload = _status_payload(
                config,
                clients=clients,
                target=args.target,
                connected=bool(SecureVault(config.home).get()),
            )
            payload["event"] = "installed"
            payload["message"] = (
                "FargoWork installed; WorkBuddy UI trust/enable remains required"
                if args.target in {"all", "workbuddy"}
                else f"FargoWork installed for {args.target}"
            )
            _emit_event(payload, output=output)
            return EXIT_OK
        if args.command == "doctor":
            payload = _doctor(config, target=args.target)
            _emit_event(payload, output=output)
            return EXIT_NEEDS_ACTION if payload["status"] == "needs_user_action" else EXIT_OK
        if args.command == "repair":
            _prepare_plugin(config)
            clients = adapters.register(args.target)
            connected = bool(SecureVault(config.home).get())
            payload = {
                "event": "repaired",
                "target": args.target,
                "installed": True,
                "connected": connected,
                "trusted": _client_trust(clients, args.target),
                "needs_user_action": not connected or _clients_need_action(clients, target=args.target),
                "clients": clients,
                "compatibility": _compatibility_contract(),
                "manual_mcp_registration": _manual_mcp_registration(config),
            }
            _emit_event(payload, output=output)
            return EXIT_OK
        if args.command == "uninstall":
            results = adapters.uninstall(args.target)
            if args.target == "all":
                try:
                    SecureVault(config.home).delete()
                except VaultError:
                    pass
                plugin_marker = config.plugin_dir / ".fargowork-owner"
                if plugin_marker.exists() or plugin_marker.is_symlink() or config.plugin_dir.is_symlink():
                    _remove_owned_tree(config.home, config.plugin_dir, label="FargoWork plugin")
            payload = {"event": "uninstalled", "installed": config.plugin_dir.exists(), "connected": False, "trusted": "unknown", "needs_user_action": any(item.get("needs_user_action") for item in results.values()), "clients": results}
            _emit_event(payload, output=output)
            return EXIT_OK
        if args.command == "login":
            session = TokenSession(config)
            auth_url, identity = session.login(browser=args.browser, timeout=args.timeout)
            payload = {"event": "logged_in", "connected": True, "identity": identity, "issuer": config.issuer, "resource": config.resource}
            _emit_event(payload, output=output)
            return EXIT_OK
        if args.command == "logout":
            TokenSession(config).logout()
            _emit_event({"event": "logged_out", "connected": False, "message": "current device credentials cleared"}, output=output)
            return EXIT_OK
        if args.command == "status":
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
            _emit_event(payload, output=output)
            return EXIT_NEEDS_ACTION if payload["needs_user_action"] else EXIT_OK
        if args.command == "update":
            payload = {"event": "update_unavailable", "status": "unavailable", "available": False, "reason": "No public FargoWork Release base URL is configured for this installation."}
            _emit_event(payload, output=output)
            return EXIT_UNAVAILABLE
        if args.command == "bridge":
            return run_bridge(TokenSession(config))
        raise FargoWorkError("unknown command", code="usage", exit_code=EXIT_USAGE)
    except FargoWorkError as exc:
        payload = {"event": "error", "status": "error", "code": exc.code, "message": str(exc), "needs_user_action": exc.exit_code == EXIT_NEEDS_ACTION}
        _emit_event(payload, output=output)
        return exc.exit_code
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        payload = {"event": "error", "status": "error", "code": "runtime_error", "message": "FargoWork could not complete the operation", "needs_user_action": False}
        _emit_event(payload, output=output)
        return EXIT_UNAVAILABLE


if __name__ == "__main__":
    raise SystemExit(main())
