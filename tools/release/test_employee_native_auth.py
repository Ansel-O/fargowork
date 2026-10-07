"""Windows native OAuth/DPAPI smoke test against an isolated loopback fixture.

Never opens a browser or contacts the real service. This is runtime evidence,
not employee/cloud acceptance. Only this invocation's temporary tree is removed.
"""
from __future__ import annotations

import argparse
import base64
import ctypes
from ctypes import wintypes
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import queue
import secrets
import socket
import subprocess
import tempfile
import threading
from urllib.parse import parse_qs, urlencode, urlsplit
import zipfile


CALLBACK = "http://127.0.0.1:37680/oauth/callback"


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def unprotect_fixture(data: bytes) -> bytes:
    """Independently decrypt ONLY the new fixture's DPAPI ciphertext in memory."""
    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_byte))]
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    crypt.CryptUnprotectData.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p,
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    crypt.CryptUnprotectData.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    result = Blob()
    check(crypt.CryptUnprotectData(ctypes.byref(source), None, None, None, None,
                                  0, ctypes.byref(result)), "fixture DPAPI decryption failed")
    try:
        return ctypes.string_at(result.data, result.size)
    finally:
        kernel.LocalFree(result.data)


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        state = self.server.fixture
        if self.path == "/auth/me" and self.headers.get("Authorization") == "Bearer " + state["access"]:
            state["me"] += 1
            self.reply(200, {"userid": "fixture-user", "corp_id": "fixture-corp",
                             "name": "Native Fixture", "scope": "fargowork:mcp"})
        else:
            state["unexpected"] += 1
            self.reply(401, {"error": "invalid_token"})

    def do_POST(self):
        state = self.server.fixture
        length = int(self.headers.get("Content-Length", "0"))
        if length > 16384:
            state["unexpected"] += 1
            self.reply(400, {"error": "invalid_request"})
            return
        form = {k: v[-1] for k, v in parse_qs(self.rfile.read(length).decode()).items()}
        if self.path == "/oauth/logout" and form.get("token") == state["refresh"]:
            state["logout"] += 1
            state["refresh"] = ""
            self.reply(200, {})
            return
        valid = self.path == "/oauth/token" and form.get("client_id") == "fargowork-cli" and form.get("resource") == state["issuer"] + "/mcp"
        if form.get("grant_type") == "authorization_code":
            challenge = base64.urlsafe_b64encode(hashlib.sha256(form.get("code_verifier", "").encode()).digest()).rstrip(b"=").decode()
            valid = valid and form.get("code") == state["code"] and form.get("redirect_uri") == CALLBACK and challenge == state.get("challenge")
            counter = "code_exchange"
        else:
            valid = valid and form.get("grant_type") == "refresh_token" and form.get("refresh_token") == state["refresh"] and bool(state["refresh"])
            counter = "refresh_exchange"
        if not valid:
            state["unexpected"] += 1
            self.reply(400, {"error": "invalid_grant"})
            return
        state[counter] += 1
        state["refresh"] = "fixture-refresh-" + secrets.token_hex(24)
        state["access"] = "fixture-access-" + secrets.token_hex(24)
        self.reply(200, {"token_type": "Bearer", "access_token": state["access"],
                         "refresh_token": state["refresh"], "expires_in": 600})


def native(exe, arguments, env, cwd):
    result = subprocess.run([str(exe), *arguments, "--output", "jsonl"], env=env,
                            cwd=cwd, capture_output=True, encoding="utf-8", timeout=30)
    events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
    check(bool(events), "native command produced no structured result")
    return result.returncode, events[-1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    check(os.name == "nt", "Windows is required for real DPAPI")
    archive = args.archive.resolve(strict=True)
    # Test exclusivity without taking over any existing callback listener.
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            probe.bind(("127.0.0.1", 37680))
        except OSError:
            raise RuntimeError("callback port 37680 is occupied; no native login was started") from None
    state = dict(access="", refresh="", code="fixture-code-" + secrets.token_hex(16),
                 me=0, code_exchange=0, refresh_exchange=0, logout=0, unexpected=0)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    server.daemon_threads = True
    server.fixture = state
    state["issuer"] = "http://127.0.0.1:" + str(server.server_port)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    login = None
    try:
        with tempfile.TemporaryDirectory(prefix="fargowork-native-auth-") as temporary:
            root = Path(temporary).resolve()
            profile = root / "隔离 用户"
            profile.mkdir()
            with zipfile.ZipFile(archive) as outer:
                names = [n for n in outer.namelist() if n.startswith("fargowork-cli-v") and n.endswith("-windows-x64.zip")]
                check(len(names) == 1, "expected exactly one native CLI archive")
                data = outer.read(names[0])
                manifest = json.loads(outer.read("release-manifest.json"))
                entry = next(item for item in manifest["artifacts"] if item["name"] == names[0])
                check(hashlib.sha256(data).hexdigest() == entry["sha256"] and len(data) == entry["size"], "native archive checksum differs")
                with zipfile.ZipFile(io.BytesIO(data)) as inner:
                    check(inner.namelist().count("fargowork.exe") == 1, "native executable missing or duplicated")
                    exe = root / "fargowork.exe"
                    exe.write_bytes(inner.read("fargowork.exe"))
            env = {k: v for k, v in os.environ.items() if not k.upper().startswith("FARGOWORK_") and not k.upper().endswith("_PROXY")}
            env.update(USERPROFILE=str(profile), HOME=str(profile),
                       APPDATA=str(profile / "AppData" / "Roaming"), LOCALAPPDATA=str(profile / "AppData" / "Local"),
                       CODEX_HOME=str(profile / ".codex"), CLAUDE_CONFIG_DIR=str(profile / ".claude"),
                       TMP=str(root / "tmp"), TEMP=str(root / "tmp"), NO_PROXY="*", no_proxy="*",
                       PYTHONIOENCODING="utf-8")
            (root / "tmp").mkdir()
            home = Path(env["APPDATA"]) / "FargoWork" / "employee"
            home.mkdir(parents=True)
            (home / "config.json").write_text(json.dumps({"environment": "employee", "issuer": state["issuer"],
                "resource": state["issuer"] + "/mcp", "resource_metadata_uri": state["issuer"] + "/.well-known/oauth-protected-resource",
                "client_id": "fargowork-cli", "redirect_uri": CALLBACK}), encoding="utf-8")
            check(not list(home.glob("vault.*")), "fixture profile was not empty")
            events = queue.Queue()
            login = subprocess.Popen([str(exe), "login", "--browser", "never", "--timeout", "25", "--output", "jsonl"],
                env=env, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8")
            def read_events():
                try:
                    for line in login.stdout:
                        events.put(json.loads(line))
                except (ValueError, OSError):
                    events.put({"event": "invalid_output"})
                finally:
                    events.put({"event": "eof"})
            reader = threading.Thread(target=read_events, daemon=True)
            reader.start()
            try:
                first = events.get(timeout=20)
                check(first.get("event") == "login_authorization_url", "native login did not start its callback listener")
                parsed = urlsplit(first["url"])
                check(parsed.scheme + "://" + parsed.netloc == state["issuer"] and parsed.path == "/oauth/authorize", "authorization origin escaped fixture")
                query = parse_qs(parsed.query)
                check(query.get("redirect_uri") == [CALLBACK] and query.get("code_challenge_method") == ["S256"], "unexpected native OAuth contract")
                state["challenge"] = query["code_challenge"][0]
                # The CLI emits the URL only after binding its own listener.
                callback = http.client.HTTPConnection("127.0.0.1", 37680, timeout=5)
                try:
                    callback.request("GET", "/oauth/callback?" + urlencode({"state": query["state"][0], "code": state["code"], "iss": state["issuer"]}))
                    response = callback.getresponse()
                    check(response.status == 200, "fixture callback failed")
                    response.read()
                finally:
                    callback.close()
                result = events.get(timeout=20)
                check(login.wait(timeout=10) == 0 and result.get("event") == "logged_in" and result.get("identity_verified") is True, "native login failed")
            finally:
                if login.poll() is None:
                    login.kill()
                    login.wait(timeout=10)
                reader.join(timeout=5)
                login.stdout.close()
            slots = list(home.glob("vault.*.dpapi"))
            check(len(slots) == 1, "expected one isolated DPAPI slot")
            ciphertext = slots[0].read_bytes()
            check(state["refresh"].encode() not in ciphertext and unprotect_fixture(ciphertext) == state["refresh"].encode(), "DPAPI slot is not encrypted fixture refresh data")
            code, result = native(exe, ["status", "--target", "manual"], env, root)
            check(code in (0, 3) and result.get("identity_verified") is True and result.get("connected") is True, "new native process could not refresh and verify identity")
            check(state["refresh_exchange"] == 1 and slots[0].read_bytes() != ciphertext and unprotect_fixture(slots[0].read_bytes()) == state["refresh"].encode(), "refresh did not rotate the DPAPI slot")
            code, result = native(exe, ["logout"], env, root)
            check(code == 0 and result.get("remote_revocation") == "confirmed" and result.get("local_credentials_cleared") is True and not slots[0].exists(), "native logout did not revoke fixture and clear slot")
            code, result = native(exe, ["status", "--target", "manual"], env, root)
            check(code == 3 and result.get("connected") is False and result.get("identity_verified") is False, "logged-out native process accepted identity")
            check(state["code_exchange"] == 1 and state["me"] == 2 and state["logout"] == 1 and state["unexpected"] == 0, "unexpected fixture request sequence")
    finally:
        server.shutdown()
        server.server_close()
    print(json.dumps({"event": "native_auth_fixture", "status": "PASS", "archive": archive.name,
        "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "checks": ["native_login_pkce", "native_me", "real_dpapi_roundtrip", "cross_process_refresh_rotation", "logout_remote_and_local", "logged_out_rejection"],
        "network": "loopback_fixture_only", "real_employee_oauth": "NOT_RUN", "cloud_acceptance": "NOT_RUN"}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        # Do not print raw native output, authorization URLs or fixture tokens.
        print(json.dumps({"event": "native_auth_fixture", "status": "FAIL", "error_type": type(error).__name__, "message": str(error) if isinstance(error, RuntimeError) else "fixture execution failed; no credential output retained"}))
        raise SystemExit(1)
