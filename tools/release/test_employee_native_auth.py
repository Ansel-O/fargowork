"""Windows native OAuth/DPAPI smoke test against an isolated loopback fixture.

Never opens a browser or contacts the real service. This is runtime evidence,
not employee/cloud acceptance. Only this invocation's temporary tree is removed.
"""
from __future__ import annotations

import argparse
import base64
import ctypes
from ctypes import wintypes
from datetime import datetime, timezone
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import queue
import re
import secrets
import socket
import subprocess
import tempfile
import threading
import time
from urllib.parse import parse_qs, urlencode, urlsplit
import zipfile


CALLBACK = "http://127.0.0.1:37680/oauth/callback"
CLIENT_VERSION = "1.2.0"
DIAGNOSTIC_EVENTS = frozenset("cli_started cli_finished installation_started preflight_result package_verified files_staged client_detection_result client_registration_result installation_finished launcher_started launcher_finished login_started login_finished listener_ready listener_failed browser_open_result authorization_waiting callback_rejected callback_accepted token_request_started token_request_result identity_result http_request_result profile_result diagnostic_exported".split())
DIAGNOSTIC_PHASES = frozenset("start preflight download verify stage detect register login listener browser callback token identity profile export finish cleanup bridge".split())
DIAGNOSTIC_OUTCOMES = frozenset("started succeeded failed rejected waiting unavailable cancelled skipped pending matched mismatch accepted denied not_attempted".split())
DIAGNOSTIC_COMPONENTS = frozenset(("cli", "bridge", "installer", "bootstrap", "launcher"))
DIAGNOSTIC_COMMANDS = frozenset("install repair uninstall login logout status doctor bridge version profile diagnostics".split())
DIAGNOSTIC_ERROR_CODES = frozenset("unknown_error diagnostic_write_failed diagnostic_export_failed usage invalid_config configuration_required runtime_error auth_required endpoint_unavailable endpoint_redirect_rejected invalid_response invalid_token_response invalid_grant invalid_token invalid_client invalid_target invalid_scope temporarily_unavailable server_error refresh_failed token_exchange_failed access_denied oauth_state_mismatch oauth_issuer_mismatch oauth_callback_invalid oauth_callback_timeout callback_port_unavailable invalid_redirect browser_unavailable secure_storage_unavailable logout_remote_failed logout_remote_unavailable invalid_jsonrpc invalid_params mcp_http_error bridge_failed missing_server_info missing_modern_capabilities mcp_protocol_version_unsupported registration_rollback_required ownership_conflict unsafe_path skill_missing invalid_client_config client_config_changed install_failed install_failed_recovery_required post_install_failed preflight_failed package_verification_failed client_not_detected client_registration_failed profile_unavailable profile_invalid profile_unsafe_path profile_write_failed profile_identity_invalid profile_preferences_invalid profile_version_invalid attempt_id_invalid codex_path_invalid client_probe_failed artifact_invalid installation_failed registration_failed login_failed identity_verification_failed permission_denied incomplete_install diagnostic_failed login_cancelled mcp_unavailable invalid_registration_mode profile_path_unsafe profile_storage_unavailable profile_data_invalid profile_incomplete profile_review_limit".split())
DIAGNOSTIC_FIELDS = frozenset("timestamp component event phase attempt_id request_id server_trace_id pid parent_pid version command outcome duration_ms http_status exit_code error_code matched".split())
STREAM_METADATA = frozenset(("diagnostic_log_dir", "diagnostic_write_failed"))
UUID_PATTERN = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
LOG_PATTERN = re.compile(r"diagnostic-\d{4}-\d{2}-\d{2}-\d{6}\.jsonl\Z")
MAX_EVENT_LINE = 128 * 1024
MAX_COMMAND_EVENTS = 256


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def validate_diagnostic(event, *, progress=False):
    """Validate a fixed public contract without retaining payloads or identity."""
    check(isinstance(event, dict), "diagnostic event is not an object")
    allowed = DIAGNOSTIC_FIELDS | STREAM_METADATA if progress else DIAGNOSTIC_FIELDS
    check(set(event) <= allowed, "diagnostic event contains an unexpected field")
    check(event.get("event") in DIAGNOSTIC_EVENTS and event.get("phase") in DIAGNOSTIC_PHASES,
          "diagnostic event is outside the fixed event or phase whitelist")
    for key, values in (("component", DIAGNOSTIC_COMPONENTS), ("command", DIAGNOSTIC_COMMANDS),
                        ("outcome", DIAGNOSTIC_OUTCOMES), ("error_code", DIAGNOSTIC_ERROR_CODES)):
        if key in event:
            check(event[key] in values, "diagnostic enum is outside its whitelist")
    for key in ("attempt_id", "request_id", "server_trace_id"):
        if key in event:
            check(isinstance(event[key], str) and UUID_PATTERN.fullmatch(event[key]),
                  "diagnostic correlation identifier is invalid")
    for key in ("pid", "parent_pid", "duration_ms", "http_status", "exit_code"):
        if key in event:
            limit = 999 if key in ("http_status", "exit_code") else 2**31 - 1
            check(type(event[key]) is int and 0 <= event[key] <= limit,
                  "diagnostic numeric value is invalid")
    if "matched" in event:
        check(type(event["matched"]) is bool, "diagnostic match flag is invalid")
    if "version" in event:
        check(event["version"] == CLIENT_VERSION, "diagnostic version differs from frozen CLI")
    if "timestamp" in event:
        try:
            stamp = datetime.fromisoformat(event["timestamp"].replace("Z", "+00:00"))
            check(stamp.tzinfo is not None and stamp.utcoffset() == timezone.utc.utcoffset(stamp),
                  "diagnostic timestamp is not UTC")
        except (ValueError, TypeError, AttributeError):
            raise RuntimeError("diagnostic timestamp is invalid") from None
    if "diagnostic_write_failed" in event:
        check(type(event["diagnostic_write_failed"]) is bool,
              "diagnostic failure flag is invalid")
    if "diagnostic_log_dir" in event:
        check(isinstance(event["diagnostic_log_dir"], str), "diagnostic directory hint is invalid")


def parse_event(line):
    check(len(line.encode("utf-8")) <= MAX_EVENT_LINE, "native event exceeds the fixture bound")
    try:
        event = json.loads(line)
    except (ValueError, TypeError):
        raise RuntimeError("native command produced invalid structured output") from None
    check(isinstance(event, dict) and isinstance(event.get("event"), str),
          "native command produced an invalid event object")
    return event


def accept_progress(event, counts):
    check(event.get("event") != "error", "native command reported an error")
    validate_diagnostic(event, progress=True)
    check(event.get("event") != "listener_failed" and event.get("outcome") not in {"failed", "rejected", "denied", "cancelled"},
          "native command reported unsuccessful progress")
    counts["progress_events"] += 1


def wait_event(events, expected, counts, timeout):
    deadline = time.monotonic() + timeout
    for _ in range(MAX_COMMAND_EVENTS):
        try:
            event = events.get(timeout=max(0.001, deadline - time.monotonic()))
        except queue.Empty:
            raise RuntimeError("native structured event wait timed out") from None
        check(isinstance(event, dict), "native command produced an invalid event object")
        check(event.get("event") not in {"invalid_output", "eof"},
              "native command ended before its expected event")
        if event.get("event") == expected:
            return event
        accept_progress(event, counts)
        check(time.monotonic() < deadline, "native structured event wait timed out")
    raise RuntimeError("native command exceeded its event count bound")


def finish_events(events, counts, timeout):
    deadline = time.monotonic() + timeout
    for _ in range(MAX_COMMAND_EVENTS):
        try:
            event = events.get(timeout=max(0.001, deadline - time.monotonic()))
        except queue.Empty:
            raise RuntimeError("native output did not close within the fixture bound") from None
        if event.get("event") == "eof":
            return
        accept_progress(event, counts)
        check(time.monotonic() < deadline, "native output did not close within the fixture bound")
    raise RuntimeError("native command exceeded its event count bound")


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
        state["issued_tokens"].extend((state["refresh"], state["access"]))
        self.reply(200, {"token_type": "Bearer", "access_token": state["access"],
                         "refresh_token": state["refresh"], "expires_in": 600})


def native(exe, arguments, env, cwd, counts):
    result = subprocess.run([str(exe), *arguments, "--output", "jsonl"], env=env,
                            cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, encoding="utf-8", timeout=30)
    lines = result.stdout.splitlines()
    check(0 < len(lines) <= MAX_COMMAND_EVENTS, "native command produced no result or too many events")
    expected = {"status": "status", "logout": "logged_out", "profile": "profile",
                "diagnostics": "diagnostics_exported"}[arguments[0]]
    terminal = None
    for line in lines:
        event = parse_event(line)
        if event.get("event") == expected:
            check(terminal is None, "native command produced duplicate terminal results")
            terminal = event
        else:
            accept_progress(event, counts)
    check(terminal is not None, "native command produced no expected terminal result")
    return result.returncode, terminal


def profile_paths(payload, home):
    profile = payload.get("profile")
    check(isinstance(profile, dict), "native command did not return a profile")
    check(profile.get("status", "ready") == "ready" and profile.get("client_version") == CLIENT_VERSION,
          "native profile is not ready at the frozen version")
    markdown = Path(profile.get("markdown_path", "")).resolve(strict=True)
    check(markdown.is_relative_to(home / "profiles") and markdown.name == "preferences.md"
          and re.fullmatch(r"[0-9a-f]{64}", markdown.parent.name),
          "native profile escaped the isolated account directory")
    metadata = markdown.with_name("metadata.json")
    check(metadata.is_file(), "native profile metadata is missing")
    return markdown, metadata


def verify_export(path, payload, sensitive_values):
    check(path.is_file() and payload.get("event_count", 0) > 0,
          "diagnostic export is missing or empty")
    total_events = 0
    event_names = set()
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        check(len(names) == len(set(names)) and "support-export.json" in names,
              "diagnostic export members are invalid")
        check(all(name == "support-export.json" or LOG_PATTERN.fullmatch(name) for name in names),
              "diagnostic export contains a non-diagnostic member")
        check(sum(info.file_size for info in archive.infolist()) <= 20 * 1024 * 1024,
              "diagnostic export exceeds its fixture bound")
        manifest = None
        for name in names:
            data = archive.read(name)
            check(all(value.encode("utf-8") not in data for value in sensitive_values if value),
                  "diagnostic export contains a fixture credential, URL, identity or profile content")
            if name == "support-export.json":
                manifest = json.loads(data)
                continue
            check(len(data) <= 2 * 1024 * 1024, "diagnostic export log exceeds its file limit")
            for line in data.splitlines(keepends=True):
                check(len(line) <= 2 * 1024, "diagnostic export event exceeds its line limit")
                event = parse_event(line.decode("utf-8"))
                validate_diagnostic(event)
                check({"timestamp", "component", "event", "phase", "attempt_id", "version", "command"} <= set(event),
                      "diagnostic export event is missing its fixed envelope")
                event_names.add(event["event"])
                total_events += 1
    check(isinstance(manifest, dict) and set(manifest) == {"schema_version", "created_at", "window_days", "event_count", "rejected_records", "contains_credentials", "contains_profiles"},
          "diagnostic export summary differs from its fixed schema")
    check(manifest["schema_version"] == 1 and manifest["window_days"] == 1
          and manifest["contains_credentials"] is False and manifest["contains_profiles"] is False
          and manifest["event_count"] == total_events == payload["event_count"]
          and manifest["rejected_records"] == payload["rejected_records"] == 0,
          "diagnostic export summary does not match its validated events")
    check({"cli_started", "cli_finished", "login_started", "login_finished", "listener_ready", "browser_open_result",
           "authorization_waiting", "callback_accepted", "token_request_started", "token_request_result", "identity_result", "profile_result"} <= event_names,
          "diagnostic export does not cover the exercised lifecycle")
    return total_events


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--expected-sha256")
    parser.add_argument("--evidence", type=Path)
    args = parser.parse_args()
    check(os.name == "nt", "Windows is required for real DPAPI")
    archive = args.archive.resolve(strict=True)
    archive_sha256 = hashlib.sha256(archive.read_bytes()).hexdigest()
    if args.expected_sha256:
        check(archive_sha256 == args.expected_sha256.lower(), "frozen employee archive checksum differs")
    if args.evidence:
        check(not args.evidence.exists(), "fixture evidence path already exists")
    # Test exclusivity without taking over any existing callback listener.
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            probe.bind(("127.0.0.1", 37680))
        except OSError:
            raise RuntimeError("callback port 37680 is occupied; no native login was started") from None
    state = dict(access="", refresh="", code="fixture-code-" + secrets.token_hex(16),
                 me=0, code_exchange=0, refresh_exchange=0, logout=0, unexpected=0, issued_tokens=[])
    counts = dict(progress_events=0)
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
                env=env, cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                text=True, encoding="utf-8")
            def read_events():
                try:
                    for _ in range(MAX_COMMAND_EVENTS):
                        line = login.stdout.readline(MAX_EVENT_LINE + 1)
                        if not line:
                            return
                        events.put(parse_event(line))
                    events.put({"event": "invalid_output"})
                except (ValueError, OSError, RuntimeError):
                    events.put({"event": "invalid_output"})
                finally:
                    events.put({"event": "eof"})
            reader = threading.Thread(target=read_events, daemon=True)
            reader.start()
            try:
                first = wait_event(events, "login_authorization_url", counts, 20)
                check(set(first) <= {"event", "url", "attempt_id", *STREAM_METADATA},
                      "native authorization event contains unexpected fields")
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
                result = wait_event(events, "logged_in", counts, 20)
                check(login.wait(timeout=10) == 0 and result.get("event") == "logged_in" and result.get("identity_verified") is True, "native login failed")
                finish_events(events, counts, 5)
            finally:
                if login.poll() is None:
                    login.kill()
                    login.wait(timeout=10)
                reader.join(timeout=5)
                login.stdout.close()
            markdown, metadata = profile_paths(result, home)
            initial_markdown = markdown.read_bytes()
            initial_metadata = json.loads(metadata.read_text(encoding="utf-8"))
            check(result.get("profile_pending_reset") is False and initial_metadata["reset_prompt_pending"] is False,
                  "first login unexpectedly requests a profile reset")
            slots = list(home.glob("vault.*.dpapi"))
            check(len(slots) == 1, "expected one isolated DPAPI slot")
            ciphertext = slots[0].read_bytes()
            check(state["refresh"].encode() not in ciphertext and unprotect_fixture(ciphertext) == state["refresh"].encode(), "DPAPI slot is not encrypted fixture refresh data")
            code, result = native(exe, ["status", "--target", "manual"], env, root, counts)
            check(code in (0, 3) and result.get("identity_verified") is True and result.get("connected") is True, "new native process could not refresh and verify identity")
            check(state["refresh_exchange"] == 1 and slots[0].read_bytes() != ciphertext and unprotect_fixture(slots[0].read_bytes()) == state["refresh"].encode(), "refresh did not rotate the DPAPI slot")
            custom_content = "employee-profile-fixture-" + secrets.token_hex(16)
            customized_markdown = initial_markdown + ("\n" + custom_content + "\n").encode("utf-8")
            markdown.write_bytes(customized_markdown)
            legacy = dict(initial_metadata)
            legacy.update(client_version="1.1.0", reviewed_client_versions=["1.1.0"],
                          reset_prompt_pending=False, preferences={"language": "en", "response_style": "detailed"})
            metadata.write_text(json.dumps(legacy), encoding="utf-8")
            code, result = native(exe, ["profile", "show"], env, root, counts)
            check(code == 0 and result.get("identity_verified") is True and result.get("profile_pending_reset") is True
                  and profile_paths(result, home) == (markdown, metadata) and markdown.read_bytes() == customized_markdown,
                  "profile upgrade did not preserve the custom document and request review")
            code, result = native(exe, ["profile", "keep"], env, root, counts)
            kept = json.loads(metadata.read_text(encoding="utf-8"))
            check(code == 0 and result.get("profile_pending_reset") is False and markdown.read_bytes() == customized_markdown
                  and kept["preferences"] == legacy["preferences"]
                  and kept["reviewed_client_versions"].count(CLIENT_VERSION) == 1,
                  "profile keep did not preserve customization or record one upgrade decision")
            code, result = native(exe, ["profile", "reset"], env, root, counts)
            reset = json.loads(metadata.read_text(encoding="utf-8"))
            check(code == 0 and result.get("profile_pending_reset") is False and markdown.read_bytes() == initial_markdown
                  and reset["preferences"] == initial_metadata["preferences"],
                  "explicit profile reset did not restore the default document and preferences")
            check(state["me"] == 5 and state["refresh_exchange"] == 4
                  and unprotect_fixture(slots[0].read_bytes()) == state["refresh"].encode(),
                  "profile operations did not reverify identity and rotate refresh once per command")
            code, result = native(exe, ["logout"], env, root, counts)
            check(code == 0 and result.get("remote_revocation") == "confirmed" and result.get("local_credentials_cleared") is True and not slots[0].exists(), "native logout did not revoke fixture and clear slot")
            code, result = native(exe, ["status", "--target", "manual"], env, root, counts)
            check(code == 3 and result.get("connected") is False and result.get("identity_verified") is False, "logged-out native process accepted identity")
            request_counts = {key: state[key] for key in ("code_exchange", "refresh_exchange", "me", "logout", "unexpected")}
            export_path = root / "support-diagnostics.zip"
            code, result = native(exe, ["diagnostics", "export", "--days", "1", "--destination", str(export_path)], env, root, counts)
            check(code == 0 and {key: state[key] for key in request_counts} == request_counts,
                  "diagnostic export contacted the fixture or failed")
            diagnostic_events = verify_export(export_path, result, [*state["issued_tokens"], state["code"],
                first["url"], query["state"][0], query["code_challenge"][0], state["issuer"], CALLBACK,
                "fixture-user", "fixture-corp", "Native Fixture", custom_content, customized_markdown.decode("utf-8")])
            check(request_counts == {"code_exchange": 1, "refresh_exchange": 4, "me": 5, "logout": 1, "unexpected": 0},
                  "unexpected fixture request sequence")
    finally:
        server.shutdown()
        server.server_close()
    evidence = {"event": "native_auth_fixture", "status": "PASS", "archive": archive.name,
        "sha256": archive_sha256, "version": CLIENT_VERSION,
        "checks": ["fixed_progress_whitelist_and_bounded_wait", "native_login_pkce", "native_me", "real_dpapi_roundtrip", "cross_process_refresh_rotation",
                   "profile_created_after_verified_login", "profile_upgrade_preserves_custom_document", "profile_keep_records_one_decision",
                   "profile_explicit_reset_restores_defaults", "profile_commands_reverify_identity", "diagnostic_export_fixed_fields_no_sensitive_data",
                   "diagnostic_export_has_no_network", "logout_remote_and_local", "logged_out_rejection"],
        "request_counts": request_counts, "stdout_progress_events": counts["progress_events"], "exported_diagnostic_events": diagnostic_events,
        "network": "loopback_fixture_only", "real_employee_oauth": "NOT_RUN", "cloud_acceptance": "NOT_RUN"}
    if args.evidence:
        args.evidence.parent.mkdir(parents=True, exist_ok=True)
        with args.evidence.open("x", encoding="utf-8") as output:
            output.write(json.dumps(evidence, ensure_ascii=True, indent=2) + "\n")
    print(json.dumps(evidence))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        # Do not print raw native output, authorization URLs or fixture tokens.
        print(json.dumps({"event": "native_auth_fixture", "status": "FAIL", "error_type": type(error).__name__, "message": str(error) if isinstance(error, RuntimeError) else "fixture execution failed; no credential output retained"}))
        raise SystemExit(1)
