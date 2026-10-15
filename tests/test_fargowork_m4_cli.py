import importlib.util
import io
import json
import os
import subprocess
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]
CLI_PATH = ROOT / "public" / "cli" / "fargowork_cli.py"


def load_cli():
    spec = importlib.util.spec_from_file_location("fargowork_m4_cli", CLI_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FakeFargoWorkHandler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path == "/auth/me":
            self.send_json(200, {"userid": "fixture-user", "name": "Fixture User", "corp_id": "fixture-corp", "scope": "fargowork:mcp"})
            return
        self.send_error(404)

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        self.server.seen_headers.append({key.lower(): value for key, value in self.headers.items()})
        if self.path == "/oauth/token":
            body = parse_qs(raw.decode("utf-8"))
            self.server.token_calls.append(body)
            if body.get("grant_type") == ["authorization_code"]:
                self.send_json(200, {"access_token": "access-1", "token_type": "Bearer", "expires_in": 600, "refresh_token": "refresh-1", "scope": "fargowork:mcp"})
            else:
                refresh = (body.get("refresh_token") or [""])[0]
                suffix = refresh.removeprefix("refresh-")
                valid_refresh = suffix.isdigit() and int(suffix) > 0
                with self.server.refresh_state_lock:
                    duplicate = refresh in self.server.used_refresh_tokens
                    if valid_refresh and not duplicate:
                        self.server.used_refresh_tokens.add(refresh)
                    self.server.refresh_token_requests.append(refresh)
                if duplicate:
                    self.server.duplicate_refresh.set()
                if valid_refresh and not duplicate:
                    if refresh == "refresh-1" and self.server.block_first_refresh:
                        self.server.first_refresh_started.set()
                        self.server.release_first_refresh.wait(10)
                    generation = int(suffix) + 1
                    self.send_json(200, {"access_token": f"access-{generation}", "token_type": "Bearer", "expires_in": 600, "refresh_token": f"refresh-{generation}", "scope": "fargowork:mcp"})
                else:
                    self.send_json(400, {"error": "invalid_grant"})
            return
        if self.path == "/mcp":
            message = json.loads(raw.decode("utf-8"))
            meta = (message.get("params") or {}).get("_meta") or {}
            if not all(
                key in meta
                for key in (
                    "io.modelcontextprotocol/protocolVersion",
                    "io.modelcontextprotocol/clientCapabilities",
                )
            ):
                self.send_json(400, {"error": "modern metadata envelope required"})
                return
            if message.get("method") == "tools/call" and self.headers.get("Mcp-Name") != (message.get("params") or {}).get("name"):
                self.send_json(400, {"error": "Mcp-Name must match the requested tool"})
                return
            self.server.mcp_methods.append((message.get("method"), self.headers.get("Authorization")))
            self.server.mcp_messages.append(message)
            if message.get("method") == "tools/list" and self.server.fail_tools_list_once:
                self.server.fail_tools_list_once = False
                self.send_json(401, {"error": "invalid_token"})
                return
            method = message.get("method")
            if method == "server/discover":
                payload = {"supportedVersions": ["2026-07-28"], "capabilities": {"tools": {"listChanged": False}, "resources": {}, "prompts": {}}, "serverInfo": {"name": "fixture", "version": "1"}}
            elif method == "tools/list":
                payload = {"tools": [{"name": "fixture_tool", "description": "fixture", "inputSchema": {"type": "object"}}]}
            elif method == "tools/call":
                payload = {"content": [{"type": "text", "text": "fixture result"}], "isError": False}
            elif method == "capabilities":
                payload = {"tools": {}}
            else:
                self.send_json(200, {"jsonrpc": "2.0", "id": message.get("id"), "error": {"code": -32601, "message": "method not found"}})
                return
            self.send_json(200, {"jsonrpc": "2.0", "id": message.get("id"), "result": payload})
            return
        self.send_error(404)

    def send_json(self, status, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        return


class RedirectSourceHandler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        self.redirect()

    def do_POST(self):  # noqa: N802
        # Consume the request before closing the HTTP/1.0 connection. Leaving
        # bytes unread can send a TCP reset on Windows and hide the 302 reply.
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.redirect()

    def redirect(self):
        self.server.redirects.append((self.command, self.path, self.headers.get("Authorization")))
        self.send_response(302)
        self.send_header("Location", f"{self.server.target}{self.path}")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *_args):
        return


class RedirectTargetHandler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        self.record()

    def do_POST(self):  # noqa: N802
        self.record()

    def record(self):
        length = int(self.headers.get("Content-Length", "0"))
        self.server.received.append((self.command, self.path, self.headers.get("Authorization"), self.rfile.read(length)))
        body = b"{}"
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        return


class FargoWorkM4CLITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cli = load_cli()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeFargoWorkHandler)
        cls.server.seen_headers = []
        cls.server.token_calls = []
        cls.server.mcp_methods = []
        cls.server.mcp_messages = []
        cls.server.fail_tools_list_once = False
        cls.server.refresh_state_lock = threading.Lock()
        cls.server.used_refresh_tokens = set()
        cls.server.refresh_token_requests = []
        cls.server.block_first_refresh = False
        cls.server.first_refresh_started = threading.Event()
        cls.server.release_first_refresh = threading.Event()
        cls.server.duplicate_refresh = threading.Event()
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        with self.server.refresh_state_lock:
            self.server.used_refresh_tokens.clear()
            self.server.refresh_token_requests.clear()
        self.server.token_calls.clear()
        self.server.mcp_methods.clear()
        self.server.mcp_messages.clear()
        self.server.fail_tools_list_once = False
        self.server.block_first_refresh = False
        self.server.first_refresh_started.clear()
        self.server.release_first_refresh.clear()
        self.server.duplicate_refresh.clear()
        self.codex_temp = __import__("tempfile").TemporaryDirectory()
        self.codex_env = patch.dict(os.environ, {"CODEX_HOME": self.codex_temp.name})
        self.codex_env.start()
        self.host_temp = __import__("tempfile").TemporaryDirectory()
        self.host_home = Path(self.host_temp.name)
        self.host_env = patch.dict(os.environ, {
            "HOME": str(self.host_home),
            "USERPROFILE": str(self.host_home),
            "APPDATA": str(self.host_home / "AppData" / "Roaming"),
            "CLAUDE_CONFIG_DIR": "",
        })
        self.host_env.start()
        self.host_path = patch.object(self.cli.Path, "home", return_value=self.host_home)
        self.host_path.start()
        self.host_detection = patch.object(self.cli, "_detect_command", return_value={"detected": False, "executable": None})
        self.host_detection.start()
        self.host_commands = patch.object(self.cli.subprocess, "run", side_effect=AssertionError("host CLI subprocess must be stubbed in this isolated suite"))
        self.host_commands.start()

    def tearDown(self):
        self.host_commands.stop()
        self.host_detection.stop()
        self.host_path.stop()
        self.host_env.stop()
        self.host_temp.cleanup()
        self.codex_env.stop()
        self.codex_temp.cleanup()

    def config(self, home):
        config = self.cli.Config(
            home=home,
            issuer=self.base,
            resource=f"{self.base}/mcp",
            resource_metadata_uri=f"{self.base}/.well-known/oauth-protected-resource",
            plugin_dir=home / "plugin" / "fargowork-employee",
        )
        skill = config.plugin_dir / "skills" / "fargowork-employee"
        skill.mkdir(parents=True, exist_ok=True)
        (skill / "SKILL.md").write_text("---\nname: fargowork\n---\n", encoding="utf-8")
        return config

    def development_config(self, home):
        config = self.config(home)
        config.environment = "development"
        return config

    def codex_entry(self, config, **overrides):
        transport = {
            "type": "stdio",
            "command": str(config.plugin_dir / "bin" / ("fargowork.cmd" if self.cli.platform.system() == "Windows" else "fargowork")),
            "args": ["bridge"],
            "env": {},
            "env_vars": [],
            "cwd": None,
        }
        entry = {
            "name": self.cli.PLUGIN_NAME,
            "enabled": True,
            "transport": transport,
        }
        for key, value in overrides.items():
            if key in {"type", "command", "args", "env", "env_vars", "cwd"}:
                transport[key] = value
            else:
                entry[key] = value
        return entry

    def codex_cli_stub(self, config, state, calls):
        def run(argv, **_kwargs):
            self.assertEqual(_kwargs.get("encoding"), "utf-8", "official host JSON output must not use the Windows locale codec")
            command = list(argv)
            calls.append(command)
            if command[1:4] == ["mcp", "list", "--json"]:
                return subprocess.CompletedProcess(command, 0, json.dumps(list(state.values())), "")
            if command[1:4] == ["mcp", "get", self.cli.PLUGIN_NAME] and command[4:5] == ["--json"]:
                name = command[3]
                if name not in state:
                    return subprocess.CompletedProcess(command, 1, "", f"MCP server {name!r} not found")
                return subprocess.CompletedProcess(command, 0, json.dumps(state[name]), "")
            if command[1:4] == ["mcp", "add", self.cli.PLUGIN_NAME]:
                if self.cli.PLUGIN_NAME in state:
                    return subprocess.CompletedProcess(command, 1, "", "already exists")
                state[self.cli.PLUGIN_NAME] = self.codex_entry(config)
                return subprocess.CompletedProcess(command, 0, "", "")
            if command[1:4] == ["mcp", "remove", self.cli.PLUGIN_NAME]:
                state.pop(self.cli.PLUGIN_NAME, None)
                return subprocess.CompletedProcess(command, 0, "", "")
            raise AssertionError(command)

        return run

    def test_employee_release_has_no_service_endpoint_default_and_keeps_loopback_redirect(self):
        self.assertEqual(self.cli.CLIENT_ENVIRONMENT, "employee")
        self.assertEqual(self.cli.PLUGIN_NAME, "fargowork-employee")
        self.assertEqual(self.cli.DEFAULT_ISSUER, "")
        self.assertEqual(self.cli.DEFAULT_RESOURCE, "")
        self.assertEqual(self.cli.DEFAULT_RESOURCE_METADATA_URI, "")
        self.assertEqual(
            self.cli.DEFAULT_REDIRECT_URI,
            "http://127.0.0.1:37680/oauth/callback",
        )

    def test_employee_config_ignores_dev_overrides_and_uses_a_separate_profile(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            root = Path(temp)
            appdata = root / "roaming"
            development_home = root / "development"
            with patch.dict(
                os.environ,
                {
                    "APPDATA": str(appdata),
                    "FARGOWORK_HOME": str(development_home),
                    "FARGOWORK_PLUGIN_DIR": str(development_home / "plugin"),
                    "FARGOWORK_ISSUER": "https://dev.example.invalid",
                    "FARGOWORK_RESOURCE": "https://dev.example.invalid/mcp",
                    "FARGOWORK_RESOURCE_METADATA_URI": "https://dev.example.invalid/.well-known/oauth-protected-resource",
                    "FARGOWORK_CLIENT_ID": "development-client",
                },
                clear=True,
            ), patch.object(self.cli.platform, "system", return_value="Windows"):
                config = self.cli.Config.load()

            self.assertEqual(config.environment, "employee")
            self.assertEqual(config.home, appdata / "FargoWork" / "employee")
            self.assertEqual(
                config.plugin_dir,
                appdata / "FargoWork" / "employee" / "plugin" / "fargowork-employee",
            )
            self.assertEqual(config.issuer, "")
            self.assertEqual(config.resource, "")
            self.assertEqual(config.resource_metadata_uri, "")
            self.assertEqual(config.client_id, "fargowork-cli")

    def test_employee_credentials_bind_environment_issuer_resource_and_client_id(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            home = Path(temp)
            first = self.cli.Config(
                home=home,
                environment="employee",
                issuer="https://one.example.invalid",
                resource="https://one.example.invalid/mcp",
                resource_metadata_uri="https://one.example.invalid/.well-known/oauth-protected-resource",
            ).secure_vault()
            second = self.cli.Config(
                home=home,
                environment="employee",
                issuer="https://two.example.invalid",
                resource="https://two.example.invalid/mcp",
                resource_metadata_uri="https://two.example.invalid/.well-known/oauth-protected-resource",
            ).secure_vault()
            dev = self.cli.Config(
                home=home,
                environment="development",
                issuer="http://127.0.0.1:8080",
                resource="http://127.0.0.1:8080/mcp",
                resource_metadata_uri="http://127.0.0.1:8080/.well-known/oauth-protected-resource",
            ).secure_vault()
            dev_other_issuer = self.cli.SecureVault(
                home,
                environment="development",
                issuer="http://127.0.0.1:8081",
                resource="http://127.0.0.1:8081/mcp",
                resource_metadata_uri="http://127.0.0.1:8081/.well-known/oauth-protected-resource",
            )
            dev_other_metadata = self.cli.SecureVault(
                home,
                environment="development",
                issuer="http://127.0.0.1:8080",
                resource="http://127.0.0.1:8080/mcp",
                resource_metadata_uri="http://127.0.0.1:8080/.well-known/other-resource",
            )
            dev_other_client = self.cli.SecureVault(
                home,
                environment="development",
                issuer="http://127.0.0.1:8080",
                resource="http://127.0.0.1:8080/mcp",
                resource_metadata_uri="http://127.0.0.1:8080/.well-known/oauth-protected-resource",
                client_id="another-client",
            )

            self.assertNotEqual(first.service, second.service)
            self.assertNotEqual(first.vault_filename, second.vault_filename)
            self.assertNotEqual(dev.service, self.cli.SecureVault.legacy_service)
            self.assertNotEqual(dev.vault_filename, "vault.dpapi")
            self.assertNotEqual(dev.service, dev_other_issuer.service)
            self.assertNotEqual(dev.vault_filename, dev_other_issuer.vault_filename)
            self.assertNotEqual(dev.service, dev_other_metadata.service)
            self.assertNotEqual(dev.vault_filename, dev_other_metadata.vault_filename)
            self.assertNotEqual(dev.service, dev_other_client.service)
            self.assertNotEqual(dev.vault_filename, dev_other_client.vault_filename)
            self.assertNotEqual(dev.service, first.service)
            fake_pwd = SimpleNamespace(getpwuid=lambda _uid: SimpleNamespace(pw_dir=str(home)))
            with patch.dict(sys.modules, {"pwd": fake_pwd}), patch.object(
                self.cli.os, "getuid", return_value=4242, create=True
            ), patch.object(self.cli.platform, "system", return_value="Linux"):
                self.assertNotEqual(first._linux_refresh_lock_path(), second._linux_refresh_lock_path())

    def test_development_refresh_does_not_read_or_delete_legacy_vault_after_issuer_change(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            home = Path(temp)
            legacy_path = home / "vault.dpapi"
            legacy_payload = b"legacy-refresh-token-fixture"
            legacy_path.write_bytes(legacy_payload)
            issuer = "https://new-service.example.invalid"
            development_env = {
                "FARGOWORK_HOME": str(home),
                "FARGOWORK_ISSUER": issuer,
                "FARGOWORK_RESOURCE": f"{issuer}/mcp",
                "FARGOWORK_RESOURCE_METADATA_URI": f"{issuer}/.well-known/oauth-protected-resource",
                "FARGOWORK_CLIENT_ID": "development-client",
                "FARGOWORK_REDIRECT_URI": self.cli.DEFAULT_REDIRECT_URI,
                "FARGOWORK_PLUGIN_DIR": str(home / "plugin"),
            }
            with patch.object(self.cli, "CLIENT_ENVIRONMENT", "development"), patch.dict(os.environ, development_env), patch.object(
                self.cli.platform, "system", return_value="Windows"
            ):
                config = self.cli.Config.load()
                vault = config.secure_vault()
                session = self.cli.TokenSession(config)
                with patch.object(
                    self.cli, "_dpapi_unprotect", side_effect=AssertionError("legacy DPAPI slot was read")
                ), patch.object(session, "_request_json", side_effect=AssertionError("refresh must not reach the network")):
                    with self.assertRaises(self.cli.AuthRequired):
                        session.refresh()
            self.assertNotEqual(vault.vault_filename, legacy_path.name)
            self.assertFalse((home / vault.vault_filename).exists())
            self.assertEqual(legacy_path.read_bytes(), legacy_payload)

    def test_employee_install_derives_server_paths_and_keeps_exact_loopback_callback(self):
        config = self.cli.Config()
        args = SimpleNamespace(
            issuer="https://candidate.example.invalid",
            resource=None,
            resource_metadata_uri=None,
            redirect_uri=None,
        )
        configured = self.cli._config_from_install(config, args)
        self.assertEqual(configured.issuer, "https://candidate.example.invalid")
        self.assertEqual(configured.resource, "https://candidate.example.invalid/mcp")
        self.assertEqual(
            configured.resource_metadata_uri,
            "https://candidate.example.invalid/.well-known/oauth-protected-resource",
        )
        self.assertEqual(
            configured.redirect_uri,
            "http://127.0.0.1:37680/oauth/callback",
        )
        self.assertEqual(configured.environment, "employee")
        with self.assertRaises(self.cli.FargoWorkError):
            self.cli._config_from_install(
                self.cli.Config(),
                SimpleNamespace(
                    issuer="https://candidate.example.invalid",
                    resource="https://other.example.invalid/mcp",
                    resource_metadata_uri=None,
                    redirect_uri=None,
                ),
            )

    def test_login_pkce_callback_and_rotating_refresh_token(self):
        with self.subTest("login"):
            with __import__("tempfile").TemporaryDirectory() as temp:
                config = self.config(Path(temp))
                vault = self.cli.MemoryVault()
                session = self.cli.TokenSession(config, vault=vault)
                events = []

                def capture(payload, **_kwargs):
                    events.append(payload)

                with patch.object(self.cli, "_emit_event", side_effect=capture), patch.object(
                    self.cli.webbrowser, "open", return_value=True
                ) as browser_open:
                    worker_error = []

                    def run_login():
                        try:
                            session.login(browser="auto", timeout=10)
                        except Exception as exc:  # pragma: no cover - assertion below reports it
                            worker_error.append(exc)

                    worker = threading.Thread(target=run_login)
                    worker.start()
                    deadline = time.time() + 3
                    while not events and time.time() < deadline:
                        time.sleep(0.01)
                    self.assertTrue(events)
                    self.assertEqual(events[0]["event"], "login_browser_opened")
                    self.assertNotIn("url", events[0])
                    query = parse_qs(urlsplit(browser_open.call_args.args[0]).query)
                    self.assertEqual(query["code_challenge_method"], ["S256"])
                    self.assertTrue(query["code_challenge"][0])
                    callback = f"{config.redirect_uri}?code=fixture-code&state={query['state'][0]}&iss={config.issuer}"
                    with urlopen(callback, timeout=3):
                        pass
                    worker.join(5)
                    self.assertFalse(worker_error, worker_error)
                    self.assertTrue(browser_open.call_args.args[0].startswith(f"{config.issuer}/oauth/authorize?"))
                self.assertEqual(vault.get(), "refresh-1")
                self.assertEqual(session.me()["userid"], "fixture-user")
                self.assertEqual(session.refresh(), "access-2")
                self.assertEqual(vault.get(), "refresh-2")
                self.assertTrue(session.access_token)
                self.assertNotIn("access-1", json.dumps(events))

    def test_token_me_and_logout_requests_reject_cross_origin_redirects(self):
        target = ThreadingHTTPServer(("127.0.0.1", 0), RedirectTargetHandler)
        target.received = []
        target_thread = threading.Thread(target=target.serve_forever, daemon=True)
        target_thread.start()
        source = ThreadingHTTPServer(("127.0.0.1", 0), RedirectSourceHandler)
        source.target = f"http://127.0.0.1:{target.server_address[1]}"
        source.redirects = []
        source_thread = threading.Thread(target=source.serve_forever, daemon=True)
        source_thread.start()
        try:
            issuer = f"http://127.0.0.1:{source.server_address[1]}"
            with __import__("tempfile").TemporaryDirectory() as temp:
                config = self.cli.Config(
                    home=Path(temp),
                    issuer=issuer,
                    resource=f"{issuer}/mcp",
                    resource_metadata_uri=f"{issuer}/.well-known/oauth-protected-resource",
                )
                me_session = self.cli.TokenSession(
                    config,
                    vault=self.cli.MemoryVault("refresh-me"),
                    access_token="access-me",
                    access_expires_at=time.time() + 300,
                )
                with self.assertRaises(self.cli.FargoWorkError) as me_error:
                    me_session.me()
                self.assertEqual(me_error.exception.code, "endpoint_redirect_rejected")

                refresh_vault = self.cli.MemoryVault("refresh-token-secret")
                refresh_session = self.cli.TokenSession(config, vault=refresh_vault)
                with self.assertRaises(self.cli.FargoWorkError) as refresh_error:
                    refresh_session.refresh()
                self.assertEqual(refresh_error.exception.code, "endpoint_redirect_rejected")
                self.assertEqual(refresh_vault.get(), "refresh-token-secret")

                logout_vault = self.cli.MemoryVault("refresh-logout-secret")
                logout_session = self.cli.TokenSession(
                    config,
                    vault=logout_vault,
                    access_token="access-logout-secret",
                    access_expires_at=time.time() + 300,
                )
                with self.assertRaises(self.cli.FargoWorkError) as logout_error:
                    logout_session.logout()
                self.assertEqual(logout_error.exception.code, "logout_remote_unavailable")
                self.assertIsNone(logout_vault.get())

            self.assertEqual(target.received, [], "redirect target received credentials or a request")
            self.assertEqual(
                [path for _method, path, _authorization in source.redirects],
                ["/auth/me", "/oauth/token", "/oauth/logout"],
            )
            self.assertEqual(source.redirects[0][2], "Bearer access-me")
        finally:
            source.shutdown()
            source.server_close()
            target.shutdown()
            target.server_close()





    def test_invalid_refresh_is_deleted_and_unknown_platform_fails_closed(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            session = self.cli.TokenSession(config, vault=self.cli.MemoryVault("old-refresh"))
            with self.assertRaises(self.cli.AuthRequired):
                session.refresh()
            self.assertIsNone(session.vault.get())
            with patch.object(self.cli.platform, "system", return_value="UnknownOS"):
                with self.assertRaises(self.cli.VaultError):
                    self.cli.SecureVault(Path(temp)).set("refresh")

    def test_logout_clears_local_credential_when_remote_revoke_is_unavailable(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            vault = self.cli.MemoryVault("refresh-1")
            session = self.cli.TokenSession(config, vault=vault, access_token="access-1")
            with patch.object(session, "_request_json", side_effect=self.cli.FargoWorkError("offline", code="endpoint_unavailable")):
                with self.assertRaises(self.cli.FargoWorkError) as caught:
                    session.logout()
            self.assertEqual(caught.exception.code, "logout_remote_unavailable")
            self.assertIn("local credentials were cleared", str(caught.exception))
            self.assertIn("remote logout could not be confirmed", str(caught.exception))
            self.assertIsNone(vault.get())
            self.assertIsNone(session.access_token)

    def test_logout_json_status_distinguishes_local_clear_from_remote_revocation(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            session = self.cli.TokenSession(
                config,
                vault=self.cli.MemoryVault("refresh-1"),
                access_token="access-1",
            )
            output = io.StringIO()
            with patch.object(self.cli.Config, "load", return_value=config), patch.object(
                self.cli, "TokenSession", return_value=session
            ), patch.object(session, "_request_json", return_value=(200, {})), patch.object(
                sys, "stdout", output
            ):
                self.assertEqual(self.cli.main(["logout", "--output", "jsonl"]), 0)
            payload = json.loads(output.getvalue())
            self.assertTrue(payload["local_credentials_cleared"])
            self.assertEqual(payload["remote_revocation"], "confirmed")
            self.assertIsNone(session.vault.get())

            no_credentials = self.cli.TokenSession(config, vault=self.cli.MemoryVault())
            self.assertEqual(
                no_credentials.logout(),
                {"local_credentials_cleared": True, "remote_revocation": "not_requested"},
            )

    def test_refresh_rotation_is_serialized_across_processes_sharing_the_vault(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            home = Path(temp)
            fixture_path = home / "refresh.fixture"
            fixture_path.write_text("refresh-1", encoding="utf-8")
            config = self.config(home)
            cli = self.cli

            class SharedFixtureVault:
                def __init__(self, vault_home):
                    self.home = Path(vault_home)
                    self.lock_provider = cli.SecureVault(self.home)

                def refresh_lock(self):
                    return self.lock_provider.refresh_lock()

                def get(self):
                    try:
                        return fixture_path.read_text(encoding="utf-8")
                    except FileNotFoundError:
                        return None

                def set(self, value):
                    fixture_path.write_text(value, encoding="utf-8")

                def delete(self):
                    fixture_path.unlink(missing_ok=True)

            parent_session = self.cli.TokenSession(config, vault=SharedFixtureVault(home))
            parent_result = []
            parent_error = []

            def refresh_in_parent():
                try:
                    parent_result.append(parent_session.refresh())
                except BaseException as exc:  # noqa: BLE001 - propagate worker errors to the assertion.
                    parent_error.append(exc)

            self.server.block_first_refresh = True
            parent_thread = threading.Thread(target=refresh_in_parent)
            parent_thread.start()
            self.assertTrue(self.server.first_refresh_started.wait(5), "parent refresh did not reach the loopback fixture")

            ready_path = home / "child.ready"
            go_path = home / "child.go"
            child_script = r'''
import importlib.util
import pathlib
import sys
import time

cli_path, home, issuer, ready_path, go_path = sys.argv[1:]
spec = importlib.util.spec_from_file_location("fargowork_lock_child", cli_path)
cli = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = cli
spec.loader.exec_module(cli)

class SharedFixtureVault:
    def __init__(self, vault_home):
        self.home = pathlib.Path(vault_home)
        self.lock_provider = cli.SecureVault(self.home)
    def refresh_lock(self):
        return self.lock_provider.refresh_lock()
    def get(self):
        try:
            return (self.home / "refresh.fixture").read_text(encoding="utf-8")
        except FileNotFoundError:
            return None
    def set(self, value):
        (self.home / "refresh.fixture").write_text(value, encoding="utf-8")
    def delete(self):
        (self.home / "refresh.fixture").unlink(missing_ok=True)

pathlib.Path(ready_path).write_text("ready", encoding="utf-8")
while not pathlib.Path(go_path).exists():
    time.sleep(0.01)
config = cli.Config(home=pathlib.Path(home), issuer=issuer, resource=issuer + "/mcp")
print(cli.TokenSession(config, vault=SharedFixtureVault(home)).refresh(), flush=True)
'''
            child = subprocess.Popen(
                [sys.executable, "-c", child_script, str(CLI_PATH), str(home), self.base, str(ready_path), str(go_path)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                deadline = time.monotonic() + 5
                while not ready_path.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(ready_path.exists(), "child process did not reach the refresh barrier")
                go_path.write_text("go", encoding="utf-8")
                duplicate_seen = self.server.duplicate_refresh.wait(1)
            finally:
                if not go_path.exists():
                    go_path.write_text("go", encoding="utf-8")
                self.server.release_first_refresh.set()

            parent_thread.join(10)
            child_stdout, child_stderr = child.communicate(timeout=10)
            self.assertFalse(parent_thread.is_alive(), "parent refresh did not finish")
            self.assertEqual(parent_error, [])
            self.assertFalse(duplicate_seen, "the child process reused a refresh token already being rotated")
            self.assertEqual(child.returncode, 0, child_stderr)
            self.assertEqual(len(parent_result), 1)
            self.assertTrue(parent_result[0].startswith("access-"))
            self.assertTrue(child_stdout.strip().startswith("access-"), child_stderr)
            self.assertEqual(self.server.refresh_token_requests, ["refresh-1", "refresh-2"])
            self.assertEqual(fixture_path.read_text(encoding="utf-8"), "refresh-3")

    def test_linux_secret_service_refresh_lock_is_shared_across_home_overrides(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            root = Path(temp)
            os_home = root / "os-home"
            os_home.mkdir()
            home_a = root / "fargowork-home-a"
            home_b = root / "fargowork-home-b"
            config_a = self.config(home_a)
            config_b = self.config(home_b)
            shared_secret = {"token": "refresh-1"}
            secret_state_lock = threading.Lock()
            secret_calls = []

            def secret_tool(args, *, input_text=None):
                secret_calls.append((list(args), input_text))
                with secret_state_lock:
                    if args[0] == "lookup":
                        return self.cli.subprocess.CompletedProcess(args, 0, shared_secret["token"] or "", "")
                    if args[0] == "store":
                        shared_secret["token"] = (input_text or "").strip()
                        return self.cli.subprocess.CompletedProcess(args, 0, "", "")
                    if args[0] == "clear":
                        shared_secret["token"] = None
                        return self.cli.subprocess.CompletedProcess(args, 0, "", "")
                raise AssertionError(args)

            vault_a = self.cli.SecureVault(home_a)
            vault_b = self.cli.SecureVault(home_b)
            fake_pwd = SimpleNamespace(
                getpwuid=lambda uid: SimpleNamespace(pw_dir=str(os_home))
            )
            with patch.dict(sys.modules, {"pwd": fake_pwd}), patch.object(
                self.cli.os, "getuid", return_value=4242, create=True
            ), patch.object(self.cli.platform, "system", return_value="Linux"), patch.dict(
                os.environ,
                {
                    "HOME": str(home_a),
                    "FARGOWORK_HOME": str(home_a),
                    "XDG_CONFIG_HOME": str(home_a / "xdg-a"),
                    "XDG_STATE_HOME": str(home_a / "state-a"),
                },
            ):
                lock_a = vault_a._linux_refresh_lock_path()
            with patch.dict(
                os.environ,
                {
                    "HOME": str(home_b),
                    "FARGOWORK_HOME": str(home_b),
                    "XDG_CONFIG_HOME": str(home_b / "xdg-b"),
                    "XDG_STATE_HOME": str(home_b / "state-b"),
                },
            ), patch.dict(sys.modules, {"pwd": fake_pwd}), patch.object(
                self.cli.os, "getuid", return_value=4242, create=True
            ), patch.object(self.cli.platform, "system", return_value="Linux"):
                lock_b = vault_b._linux_refresh_lock_path()
            expected_lock = (
                os_home
                / ".local"
                / "state"
                / "fargowork"
                / f"{vault_a.service}.{vault_a.linux_account}.lock"
            )
            self.assertEqual(lock_a, expected_lock)
            self.assertEqual(lock_b, expected_lock)

            with patch.dict(sys.modules, {"pwd": fake_pwd}), patch.object(
                self.cli.os, "getuid", return_value=4242, create=True
            ), patch.object(self.cli.platform, "system", return_value="Linux"), patch.object(
                vault_a, "_run_secret_tool", side_effect=secret_tool
            ), patch.object(vault_b, "_run_secret_tool", side_effect=secret_tool):
                session_a = self.cli.TokenSession(config_a, vault=vault_a)
                session_b = self.cli.TokenSession(config_b, vault=vault_b)
                results = []
                errors = []

                def refresh(session):
                    try:
                        results.append(session.refresh())
                    except BaseException as exc:  # noqa: BLE001 - assert worker failures below.
                        errors.append(exc)

                self.server.block_first_refresh = True
                first = threading.Thread(target=refresh, args=(session_a,))
                second = threading.Thread(target=refresh, args=(session_b,))
                first.start()
                self.assertTrue(
                    self.server.first_refresh_started.wait(5),
                    "first Linux Secret Service refresh did not reach the loopback barrier",
                )
                second.start()
                duplicate_seen = self.server.duplicate_refresh.wait(0.3)
                self.server.release_first_refresh.set()
                first.join(10)
                second.join(10)

            self.assertFalse(first.is_alive())
            self.assertFalse(second.is_alive())
            self.assertFalse(duplicate_seen, "different FargoWork homes raced the shared Secret Service item")
            self.assertEqual(errors, [])
            self.assertEqual(len(results), 2)
            self.assertEqual(self.server.refresh_token_requests, ["refresh-1", "refresh-2"])
            self.assertEqual(shared_secret["token"], "refresh-3")
            self.assertTrue(secret_calls)
            for args, _input_text in secret_calls:
                self.assertIn("service", args)
                self.assertIn(vault_a.service, args)
                self.assertIn("account", args)
                self.assertIn(vault_a.linux_account, args)






    def test_cli_jsonl_preserves_unicode_paths_through_legacy_console_pipes(self):
        payload = {"event": "installed", "command": "C:/用户/空 格/fargowork.exe"}
        output = io.StringIO()
        with patch.object(sys, "stdout", output):
            self.cli._emit_event(payload, output="jsonl")
        encoded = output.getvalue().encode("ascii")
        # Legacy Windows console decoding does not alter this byte stream.
        self.assertEqual(json.loads(encoded.decode("cp936")), payload)








    def test_managed_skill_local_changes_survive_repair(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            self.cli._prepare_canonical_skill(config)
            path = self.cli._canonical_skill_path(config) / "SKILL.md"
            changed = path.read_bytes() + b'\nmy local preference\n'
            path.write_bytes(changed)
            with self.assertRaises(self.cli.FargoWorkError) as failure:
                self.cli._prepare_canonical_skill(config)
            self.assertEqual(failure.exception.code, "modified_skill_preserved")
            self.assertEqual(path.read_bytes(), changed)

    def test_atomic_skill_copy_preserves_foreign_backup(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            source.mkdir()
            (source / "SKILL.md").write_text("new Skill", encoding="utf-8")
            target = root / "owned-skill"
            target.mkdir()
            (target / ".fargowork-owner").write_text(self.cli.MARKER, encoding="utf-8")
            (target / "SKILL.md").write_text("old Skill", encoding="utf-8")
            backup = root / "owned-skill.backup"
            backup.mkdir()
            (backup / "personal.txt").write_text("keep backup", encoding="utf-8")
            with self.assertRaises(self.cli.FargoWorkError):
                self.cli._copy_tree_atomic(source, target)
            self.assertEqual((target / "SKILL.md").read_text(), "old Skill")
            self.assertEqual((backup / "personal.txt").read_text(), "keep backup")

    def test_atomic_skill_copy_restores_old_target_when_publish_fails_after_move(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            source.mkdir()
            (source / "SKILL.md").write_text("new Skill", encoding="utf-8")
            target = root / "owned-skill"
            target.mkdir()
            (target / ".fargowork-owner").write_text(self.cli.MARKER, encoding="utf-8")
            (target / "SKILL.md").write_text("old Skill", encoding="utf-8")
            replace = self.cli.os.replace
            def publish_failure(src, dst):
                if Path(src).name == target.name and Path(src).parent.name.startswith(".owned-skill-"):
                    raise OSError("fixture publish failure")
                return replace(src, dst)
            with patch.object(self.cli.os, "replace", side_effect=publish_failure):
                with self.assertRaises(OSError):
                    self.cli._copy_tree_atomic(source, target)
            self.assertEqual((target / "SKILL.md").read_text(), "old Skill")
            self.assertFalse(target.with_name("owned-skill.backup").exists())




















    def test_macos_vault_fails_closed_without_token_in_subprocess_argv(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            vault = self.cli.SecureVault(Path(temp))
            with patch.object(self.cli.platform, "system", return_value="Darwin"), patch.object(self.cli.subprocess, "run") as run:
                with self.assertRaises(self.cli.VaultError):
                    vault._mac_set("refresh-secret-fixture")
                with self.assertRaises(self.cli.VaultError):
                    vault._mac_get()
                with self.assertRaises(self.cli.VaultError):
                    vault._mac_delete()
                run.assert_not_called()

    def test_plugin_source_and_uninstall_reject_unsafe_paths(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            root = Path(temp)
            home = root / "home"
            source = root / "source"
            source.mkdir(parents=True)
            (source / "plugin.json").write_text("{}", encoding="utf-8")
            config = self.config(home)
            config.plugin_dir = root / "outside-plugin"
            with self.assertRaises(self.cli.FargoWorkError) as boundary_error:
                self.cli._prepare_plugin(config, source)
            self.assertEqual(boundary_error.exception.code, "unsafe_path")

            config = self.config(home)
            outside = root / "outside.txt"
            outside.write_text("outside", encoding="utf-8")
            unsafe_owned = root / "unsafe-owned"
            unsafe_owned.mkdir()
            (unsafe_owned / ".fargowork-owner").write_text(self.cli.MARKER, encoding="utf-8")
            config.plugin_dir = unsafe_owned
            with self.assertRaises(self.cli.FargoWorkError) as uninstall_boundary_error:
                self.cli._remove_owned_tree(config.home, config.plugin_dir, label="FargoWork plugin")
            self.assertEqual(uninstall_boundary_error.exception.code, "unsafe_path")
            config.plugin_dir = self.config(home).plugin_dir
            try:
                (source / "escape.txt").symlink_to(outside)
            except (OSError, NotImplementedError):
                self.skipTest("directory symlinks are unavailable on this Windows test host")
            config = self.config(home)
            with self.assertRaises(self.cli.FargoWorkError) as source_error:
                self.cli._prepare_plugin(config, source)
            self.assertEqual(source_error.exception.code, "unsafe_path")

            # self.config() creates a real plugin Skill tree; use a fresh link path.
            linked_home = root / "linked-plugin-home"
            plugin = linked_home / "plugin" / "fargowork-employee"
            plugin.parent.mkdir(parents=True, exist_ok=True)
            target = root / "owned-outside"
            target.mkdir()
            (target / ".fargowork-owner").write_text(self.cli.MARKER, encoding="utf-8")
            plugin.symlink_to(target, target_is_directory=True)
            with self.assertRaises(self.cli.FargoWorkError) as uninstall_error:
                self.cli._remove_owned_tree(linked_home, plugin, label="FargoWork plugin")
            self.assertEqual(uninstall_error.exception.code, "unsafe_path")
            self.assertTrue(target.exists())


if __name__ == "__main__":
    unittest.main()
