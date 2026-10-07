import importlib.util
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlencode, parse_qs, urlsplit
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
CLIENT = ROOT / "public" / "cli"
sys.path.insert(0, str(CLIENT))
import client_diagnostics as diag
import fargowork_cli as cli


class DiagnosticStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.now = datetime(2026, 10, 7, 5, 0, tzinfo=timezone.utc)
        self.log = diag.DiagnosticLog(self.home / "diagnostics", version="1.2.0", command="login", clock=lambda: self.now)

    def records(self):
        return [json.loads(line) for path in sorted(self.log.root.glob("diagnostic-*.jsonl")) for line in path.read_text("utf-8").splitlines()]

    def test_defaults_and_shared_employee_namespace(self):
        self.assertEqual((diag.RETENTION_DAYS, diag.DIRECTORY_BYTES, diag.FILE_BYTES, diag.EVENT_BYTES), (7, 20 * 1024 * 1024, 2 * 1024 * 1024, 2 * 1024))
        log = diag.DiagnosticLog.for_home(self.home / "FargoWork" / "employee", version="1.2.0")
        self.assertEqual(log.root, self.home / "FargoWork" / "diagnostics")
        self.assertFalse(log.root.exists())

    def test_whitelist_never_records_payload_or_identity(self):
        secrets = {"url": "https://example.invalid/?state=private-state", "token": "private-token", "identity": {"userid": "private-user"}, "profile": "private-profile", "stderr": "private-stderr", "headers": {"Authorization": "Bearer private-token"}}
        self.assertTrue(self.log.record("login_started", "login", **secrets, error_code="private-token", server_trace_id="private-user", duration_ms=4))
        record = self.records()[0]
        self.assertEqual(record["error_code"], "unknown_error")
        self.assertFalse(set(record) & set(secrets))
        self.assertNotIn("server_trace_id", record)
        serialized = json.dumps(record)
        self.assertNotIn("private-", serialized)
        self.assertLessEqual(len(serialized.encode()) + 1, diag.EVENT_BYTES)
        self.assertTrue(diag.UUID_PATTERN.fullmatch(record["attempt_id"]))

    def test_non_enum_event_or_phase_cannot_store_text(self):
        self.assertFalse(self.log.record("private-token", "login"))
        self.assertFalse(self.log.record("login_started", "private-profile"))
        self.assertFalse(self.log.root.exists())
        self.assertTrue(self.log.write_failed)

    def test_size_rotation_total_cap_and_valid_json(self):
        with patch.object(diag, "DIRECTORY_BYTES", 4096), patch.object(diag, "FILE_BYTES", 1024):
            for _ in range(50):
                self.assertTrue(self.log.record("login_started", "login", outcome="started"))
            files = list(self.log.root.iterdir())
            self.assertLessEqual(sum(path.stat().st_size for path in files), 4096)
            self.assertGreater(len(self.records()), 0)
            self.assertTrue(all(path.stat().st_size <= 1024 for path in files))

    def test_expired_owned_files_deleted_foreign_file_preserved(self):
        self.assertTrue(self.log.record("login_started", "login"))
        old = self.log.root / "diagnostic-2026-09-29-000001.jsonl"
        old.write_text("old", "utf-8")
        unrelated = self.log.root / "unrelated.txt"
        unrelated.write_text("keep", "utf-8")
        self.assertTrue(self.log.record("login_finished", "finish"))
        self.assertFalse(old.exists())
        self.assertEqual(unrelated.read_text(), "keep")

    def test_foreign_files_are_counted_but_never_deleted(self):
        self.assertTrue(self.log.record("login_started", "login"))
        unrelated = self.log.root / "unrelated.txt"
        unrelated.write_bytes(b"x" * 1200)
        with patch.object(diag, "DIRECTORY_BYTES", 1024):
            self.assertFalse(self.log.record("login_finished", "finish"))
        self.assertEqual(unrelated.stat().st_size, 1200)

    def test_export_reserializes_whitelist_and_does_not_copy_profiles(self):
        self.assertTrue(self.log.record("login_started", "login"))
        (self.home / "vault.dpapi").write_bytes(b"private-credential")
        (self.home / "preferences.md").write_text("private-profile")
        path = next(self.log.root.glob("diagnostic-*.jsonl"))
        injected = {"timestamp": self.now.isoformat(), "event": "login_finished", "phase": "finish", "identity": "private-user", "url": "https://invalid/?code=private-code", "refresh_token": "private-token"}
        with path.open("a", encoding="utf-8") as output:
            output.write(json.dumps(injected) + "\n[]\nnot-json\n")
        export = self.home / "support.zip"
        result = self.log.export(export, days=1)
        self.assertEqual(result["event_count"], 2)
        self.assertEqual(result["rejected_records"], 2)
        with zipfile.ZipFile(export) as archive:
            joined = b"".join(archive.read(name) for name in archive.namelist())
            self.assertNotIn(b"private-", joined)
            self.assertTrue(all(name == "support-export.json" or diag.FILE_PATTERN.fullmatch(name) for name in archive.namelist()))
        self.assertEqual((self.home / "vault.dpapi").read_bytes(), b"private-credential")

    def test_export_refuses_overwrite_and_reserved_destination(self):
        self.log.record("login_started", "login")
        export = self.home / "existing.zip"
        export.write_bytes(b"keep")
        with self.assertRaises(diag.DiagnosticError):
            self.log.export(export)
        self.assertEqual(export.read_bytes(), b"keep")
        with self.assertRaises(diag.DiagnosticError):
            self.log.export(self.log.root / "support.zip")
        reserved = self.home / "PROFILES" / "support.zip"
        with self.assertRaises(diag.DiagnosticError):
            self.log.export(reserved)
        self.assertFalse(reserved.parent.exists())

    def test_hardlinked_log_or_lock_is_refused_without_touching_target(self):
        for filename in (diag.LOCK_NAME, "diagnostic-2026-10-07-000001.jsonl"):
            with self.subTest(filename=filename):
                root = self.home / uuid.uuid4().hex
                root.mkdir()
                target = self.home / f"target-{uuid.uuid4().hex}"
                target.write_bytes(b"keep")
                os.link(target, root / filename)
                log = diag.DiagnosticLog(root, version="1.2.0")
                self.assertFalse(log.record("login_started", "login"))
                self.assertEqual(target.read_bytes(), b"keep")

    @unittest.skipUnless(os.name == "nt", "Windows junction behavior")
    def test_windows_junction_directory_refused(self):
        target = self.home / "outside"
        target.mkdir()
        result = subprocess.run(["cmd", "/c", "mklink", "/J", str(self.log.root), str(target)], capture_output=True, stdin=subprocess.DEVNULL)
        if result.returncode:
            self.skipTest("junction creation unavailable")
        self.assertFalse(self.log.record("login_started", "login"))
        self.assertEqual(list(target.iterdir()), [])

    def test_cross_process_writer_serializes_budget_and_rotation(self):
        script = """import sys,pathlib
sys.path.insert(0,sys.argv[1])
import client_diagnostics as d
d.DIRECTORY_BYTES=4096; d.FILE_BYTES=1024
log=d.DiagnosticLog(pathlib.Path(sys.argv[2]),version='1.2.0',command='login')
assert all(log.record('login_started','login',outcome='started') for _ in range(15))
"""
        workers = [subprocess.Popen([sys.executable, "-c", script, str(CLIENT), str(self.log.root)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(3)]
        for worker in workers:
            out, error = worker.communicate(timeout=20)
            self.assertEqual(worker.returncode, 0, (out, error))
        self.assertLessEqual(sum(path.stat().st_size for path in self.log.root.iterdir()), 4096)
        self.assertGreater(len(self.records()), 0)


class ClientDiagnosticBehaviorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.config = cli.Config(home=self.home, issuer="https://fixture.example.invalid", resource="https://fixture.example.invalid/mcp", resource_metadata_uri="https://fixture.example.invalid/.well-known/oauth-protected-resource", plugin_dir=self.home / "plugin")

    def test_old_and_wrong_issuer_callbacks_do_not_wake_login(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        waiter = cli._CallbackWaiter(f"http://127.0.0.1:{port}/oauth/callback", expected_state="new-state", expected_issuer="https://fixture.example.invalid", diagnostics=diag.DiagnosticLog(self.home / "logs", version="1.2.0"))
        waiter.start()
        self.addCleanup(waiter.close)
        for values in ({"state": "old-state", "iss": "https://fixture.example.invalid", "code": "secret-old"}, {"state": "new-state", "iss": "https://wrong.example.invalid", "code": "secret-code"}, {"state": "错误链接", "iss": "https://fixture.example.invalid", "code": "secret-code"}):
            with self.assertRaises(HTTPError) as caught:
                urlopen(waiter.redirect_uri + "?" + urlencode(values), timeout=3)
            self.assertEqual(caught.exception.code, 400)
            self.assertFalse(waiter.event.is_set())
        with urlopen(waiter.redirect_uri + "?" + urlencode({"state": "new-state", "iss": "https://fixture.example.invalid", "code": "secret-valid"}), timeout=3) as response:
            self.assertIn(b"callback validated", response.read())
        self.assertTrue(waiter.event.is_set())
        self.assertEqual(waiter.result["code"], "secret-valid")
        raw_logs = b"".join(path.read_bytes() for path in waiter.diagnostics.root.glob("*.jsonl"))
        self.assertNotIn(b"secret-", raw_logs)
        self.assertNotIn(b"new-state", raw_logs)

    def test_duplicate_login_does_not_close_original_listener(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        address = f"http://127.0.0.1:{port}/oauth/callback"
        first = cli._CallbackWaiter(address, expected_state="first-state", expected_issuer="https://fixture.example.invalid")
        first.start()
        self.addCleanup(first.close)
        second = cli._CallbackWaiter(address, expected_state="second-state", expected_issuer="https://fixture.example.invalid")
        with self.assertRaises(cli.FargoWorkError) as caught:
            second.start()
        self.assertEqual(caught.exception.code, "callback_port_unavailable")
        second.close()
        with urlopen(address + "?" + urlencode({"state": "first-state", "iss": "https://fixture.example.invalid", "code": "first-code"}), timeout=3) as response:
            self.assertEqual(response.status, 200)
        self.assertEqual(first.result["state"], "first-state")

    def test_completed_listener_can_be_reopened_without_stopping_other_processes(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        address = f"http://127.0.0.1:{port}/oauth/callback"
        for state in ("first-state", "second-state"):
            waiter = cli._CallbackWaiter(address, expected_state=state, expected_issuer="https://fixture.example.invalid")
            waiter.start()
            try:
                with urlopen(address + "?" + urlencode({"state": state, "iss": "https://fixture.example.invalid", "code": "fixture-code"}), timeout=3) as response:
                    response.read()
                self.assertEqual(waiter.result["state"], state)
            finally:
                waiter.close()

    def test_profile_uses_verified_identity_and_returns_binding_for_mcp_comparison(self):
        identity = {"corp_id": "fixture-corp", "userid": "fixture-user"}
        with patch.object(cli.Config, "load", return_value=self.config), patch.object(cli.TokenSession, "me", return_value=identity), patch("sys.stdout", io.StringIO()) as output:
            self.assertEqual(cli.main(["profile", "show", "--output", "jsonl"]), 0)
            event = json.loads(output.getvalue().splitlines()[-1])
        self.assertEqual(event["identity"], identity)
        self.assertTrue(event["identity_verified"])
        self.assertTrue(Path(event["profile"]["markdown_path"]).is_file())
        self.assertNotIn("fixture-user", Path(event["profile"]["markdown_path"]).name)
        with self.assertRaises(SystemExit), patch("sys.stderr", io.StringIO()):
            cli._build_parser().parse_args(["profile", "show", "--userid", "someone-else"])

    def test_profile_does_not_create_before_authentication(self):
        with patch.object(cli.Config, "load", return_value=self.config), patch.object(cli.TokenSession, "me", side_effect=cli.AuthRequired()), patch("sys.stdout", io.StringIO()) as output:
            self.assertEqual(cli.main(["profile", "show", "--output", "jsonl"]), 3)
        self.assertFalse((self.home / "profiles").exists())

    def test_logger_failure_does_not_turn_verified_status_into_auth_failure(self):
        identity = {"corp_id": "fixture-corp", "userid": "fixture-user"}
        self.config.plugin_dir.mkdir()
        (self.config.plugin_dir / "plugin.json").write_text("{}")
        (self.config.plugin_dir / "mcp.json").write_text("{}")
        with patch.object(cli.Config, "load", return_value=self.config), patch.object(cli.TokenSession, "me", return_value=identity), patch.object(diag.DiagnosticLog, "record", return_value=False), patch("sys.stdout", io.StringIO()) as output, patch("sys.stderr", io.StringIO()) as error:
            self.assertEqual(cli.main(["status", "--target", "manual", "--output", "jsonl"]), 3)
            result = json.loads(output.getvalue().splitlines()[-1])
        self.assertTrue(result["identity_verified"])
        self.assertTrue(result["connected"])
        self.assertTrue(result["diagnostic_write_failed"])
        self.assertIn("diagnostic_write_failed", error.getvalue())
        self.assertEqual(len(output.getvalue().splitlines()), 1)

    def test_explicit_codex_path_does_not_search_or_guess_versions(self):
        path = self.home / "codex.exe"
        path.write_bytes(b"fixture")
        config = self.config
        config.codex_path = str(path)
        adapters = cli.ClientAdapters(config)
        with patch.object(cli, "_detect_command", side_effect=AssertionError("must not guess")):
            self.assertEqual(adapters._detect_codex()["executable"], str(path))
            path.unlink()
            self.assertFalse(adapters._detect_codex()["detected"])
        self.assertEqual(config.codex_path, str(path))

    def test_http_trace_ids_associate_events_without_logging_identity(self):
        seen = []
        server_trace = str(uuid.uuid4())

        class Handler(BaseHTTPRequestHandler):
            def do_GET(inner):
                seen.append(dict(inner.headers))
                raw = b'{"corp_id":"sensitive-corp","userid":"sensitive-user"}'
                inner.send_response(200)
                inner.send_header("X-Trace-ID", server_trace)
                inner.send_header("Content-Length", str(len(raw)))
                inner.end_headers()
                inner.wfile.write(raw)

            def log_message(inner, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        config = self.config
        config.issuer = f"http://127.0.0.1:{server.server_address[1]}"
        session = cli.TokenSession(config, vault=cli.MemoryVault(), access_token="private-access", access_expires_at=10**12)
        self.assertEqual(session.me()["userid"], "sensitive-user")
        self.assertTrue(diag.UUID_PATTERN.fullmatch(seen[0]["X-Trace-Id"]))
        self.assertEqual(seen[0]["X-Fargowork-Attempt-Id"], session.diagnostics.attempt_id)
        records = [json.loads(line) for path in session.diagnostics.root.glob("*.jsonl") for line in path.read_text().splitlines()]
        request = next(event for event in records if event["event"] == "http_request_result")
        self.assertEqual(request["server_trace_id"], server_trace)
        raw = json.dumps(records)
        self.assertNotIn("sensitive-", raw)
        self.assertNotIn("private-access", raw)

    def test_bridge_configuration_error_stays_on_stderr(self):
        self.config.issuer = ""
        with patch.object(cli.Config, "load", return_value=self.config), patch("sys.stdout", io.StringIO()) as output, patch("sys.stderr", io.StringIO()) as error:
            self.assertEqual(cli.main(["bridge"]), 2)
        self.assertEqual(output.getvalue(), "")
        self.assertIn("configuration_required", error.getvalue())

    def test_partial_identity_does_not_report_verified_or_create_profile(self):
        session = cli.TokenSession(self.config, vault=cli.MemoryVault(), access_token="fixture-access", access_expires_at=10**12)
        with patch.object(session, "_request_json", return_value=(200, {"userid": "only-user"})):
            with self.assertRaises(cli.FargoWorkError) as caught:
                session.me()
        self.assertEqual(caught.exception.code, "invalid_response")
        self.assertFalse((self.home / "profiles").exists())


if __name__ == "__main__":
    unittest.main()
