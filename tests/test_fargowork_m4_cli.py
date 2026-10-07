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

    def test_bridge_translates_initialize_and_retries_one_401_without_leaking_tokens(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            session = self.cli.TokenSession(config, vault=self.cli.MemoryVault("refresh-1"), access_token="access-1", access_expires_at=time.time() + 300)
            self.server.fail_tools_list_once = True
            input_stream = io.StringIO(
                json.dumps({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "clientInfo": {"name": "codex-fixture", "version": "1"},
                    },
                }) + "\n"
                + json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {"_meta": {"io.modelcontextprotocol/protocolVersion": "2025-06-18"}}}) + "\n"
                + json.dumps({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "fixture_tool", "arguments": {}}}) + "\n"
                + json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}) + "\n"
            )
            output_stream = io.StringIO()
            exit_code = self.cli.run_bridge(session, input_stream=input_stream, output_stream=output_stream)
            self.assertEqual(exit_code, 0)
            responses = [json.loads(line) for line in output_stream.getvalue().splitlines()]
            self.assertEqual([response["id"] for response in responses], [1, 2, 3])
            self.assertEqual(responses[0]["result"]["protocolVersion"], "2025-11-25")
            self.assertEqual(responses[0]["result"]["capabilities"], {"tools": {"listChanged": False}})
            self.assertEqual(responses[1]["result"]["tools"][0]["name"], "fixture_tool")
            self.assertFalse(responses[2]["result"]["isError"])
            self.assertEqual(session.vault.get(), "refresh-2")
            self.assertIn(("server/discover", "Bearer access-1"), self.server.mcp_methods)
            self.assertIn(("tools/list", "Bearer access-2"), self.server.mcp_methods)
            call_headers = next(
                headers
                for headers in reversed(self.server.seen_headers)
                if headers.get("mcp-method") == "tools/call"
            )
            self.assertEqual(call_headers["mcp-name"], "fixture_tool")
            for message in self.server.mcp_messages[-4:]:
                meta = message["params"]["_meta"]
                self.assertEqual(meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28")
                self.assertIn("io.modelcontextprotocol/clientCapabilities", meta)
            self.assertEqual(
                self.server.mcp_messages[0]["params"]["_meta"]["io.modelcontextprotocol/clientInfo"]["name"],
                "codex-fixture",
            )
            for headers in self.server.seen_headers:
                if headers.get("mcp-method") in {"server/discover", "tools/list", "tools/call"}:
                    self.assertEqual(headers["mcp-protocol-version"], "2026-07-28")
            self.assertNotIn("access-1", output_stream.getvalue())
            self.assertNotIn("refresh-1", output_stream.getvalue())

    def test_bridge_returns_only_supported_protocol_and_diagnoses_strict_client_rejection(self):
        self.assertEqual(self.cli.BRIDGE_SUPPORTED_PROTOCOL_VERSIONS, ("2025-11-25",))
        self.assertEqual(self.cli._negotiate_client_protocol_version("2025-11-25"), "2025-11-25")
        self.assertEqual(self.cli._negotiate_client_protocol_version("unrecognized-version"), "2025-11-25")
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            session = self.cli.TokenSession(
                config,
                vault=self.cli.MemoryVault("refresh-1"),
                access_token="access-1",
                access_expires_at=time.time() + 300,
            )
            strict_client_versions = {"2024-11-05"}
            request = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "strict-fixture", "version": "1"},
                },
            }
            output_stream = io.StringIO()
            diagnostic_stream = io.StringIO()
            exit_code = self.cli.run_bridge(
                session,
                input_stream=io.StringIO(json.dumps(request) + "\n"),
                output_stream=output_stream,
                diagnostic_stream=diagnostic_stream,
            )
            response = json.loads(output_stream.getvalue())
            selected = response["result"]["protocolVersion"]
            self.assertEqual(selected, "2025-11-25")
            self.assertNotIn(selected, strict_client_versions)
            self.assertEqual(exit_code, self.cli.EXIT_PROTOCOL)
            self.assertIn("client closed before confirming", diagnostic_stream.getvalue())
            self.assertIn("2024-11-05", diagnostic_stream.getvalue())
            self.assertIn("2025-11-25", diagnostic_stream.getvalue())
            self.assertEqual(self.server.mcp_messages[-1]["method"], "server/discover")
            self.assertEqual(
                self.server.mcp_messages[-1]["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"],
                "2026-07-28",
            )

    def test_bridge_rejects_malformed_initialize_params_before_upstream_call(self):
        malformed_requests = [
            ("initialize", {}),
            ("initialize", {"protocolVersion": "2025-06-18", "capabilities": []}),
            ("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "fixture"}}),
            ("tools/list", {"cursor": 7}),
            ("tools/call", {"name": "fixture_tool", "arguments": []}),
        ]
        for method, params in malformed_requests:
            with self.subTest(method=method, params=params):
                output_stream = io.StringIO()
                message = {"jsonrpc": "2.0", "id": 10, "method": method, "params": params}
                exit_code = self.cli.run_bridge(
                    SimpleNamespace(),
                    input_stream=io.StringIO(json.dumps(message) + "\n"),
                    output_stream=output_stream,
                    diagnostic_stream=io.StringIO(),
                )
                response = json.loads(output_stream.getvalue())
                self.assertEqual(exit_code, self.cli.EXIT_PROTOCOL)
                self.assertEqual(response["error"]["code"], -32602)
                self.assertEqual(response["id"], 10)
        self.assertEqual(self.server.mcp_methods, [])

    def test_bridge_forces_utf8_for_non_ascii_tool_results(self):
        input_stream = io.StringIO(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {"name": "fixture_tool", "arguments": {}},
                }
            )
            + "\n"
        )
        wire = io.BytesIO()
        output_stream = io.TextIOWrapper(wire, encoding="cp1252")
        response = {
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "content": [{"type": "text", "text": "我要申请出差"}],
                "isError": False,
            },
        }
        with patch.object(self.cli.MCPHTTPClient, "request", return_value=response):
            exit_code = self.cli.run_bridge(
                SimpleNamespace(), input_stream=input_stream, output_stream=output_stream
            )
        output_stream.flush()
        self.assertEqual(exit_code, 0)
        self.assertIn("我要申请出差", wire.getvalue().decode("utf-8"))

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

    def test_adapter_ownership_preserves_foreign_entry(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            home = Path(temp)
            config = self.development_config(home)
            adapters = self.cli.ClientAdapters(config)
            adapters.register("codex")
            path = home / "adapters" / "codex.json"
            self.assertEqual(json.loads(path.read_text())["owner"], self.cli.MARKER)
            path.write_text(json.dumps({"owner": "other-client", "command": "keep-me"}), encoding="utf-8")
            result = adapters.register("codex")["codex"]
            self.assertFalse(result["registered"])
            self.assertEqual(json.loads(path.read_text())["command"], "keep-me")

    def test_employee_parser_defaults_to_cli_and_accepts_each_host(self):
        parser = self.cli._build_parser()
        for command in ("install", "repair", "doctor", "status", "uninstall"):
            self.assertEqual(parser.parse_args([command]).target, "cli")
            for target in ("manual", "auto", "all", "codex", "cursor", "workbuddy", "claude-code"):
                self.assertEqual(parser.parse_args([command, "--target", target]).target, target)

    def test_host_cli_probes_request_utf8_output_for_chinese_paths(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp) / "员工配置")
            adapters = self.cli.ClientAdapters(config, registration_mode="official")
            def run(argv, **kwargs):
                self.assertEqual(kwargs.get("encoding"), "utf-8")
                self.assertIs(kwargs.get("text"), True)
                return subprocess.CompletedProcess(argv, 0, "已连接：" + adapters._bridge_command() + " bridge", "")
            with patch.object(self.cli.subprocess, "run", side_effect=run):
                self.assertEqual(adapters._codebuddy_probe("codebuddy")["status"], "present")
                self.assertEqual(adapters._claude_probe("claude")["status"], "present")

    def test_codex_post_add_uncertainty_requests_retaining_shared_executable(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            adapters = self.cli.ClientAdapters(config, registration_mode="official")
            for name in ("plugin.json", "mcp.json"):
                (config.plugin_dir / name).write_text("{}", encoding="utf-8")
            states = [{"status": "absent"}, {"status": "error"}, {"status": "error"}]
            with patch.object(self.cli, "_detect_command", return_value={"detected": True, "executable": "codex"}), patch.object(
                adapters, "_codex_mcp_state", side_effect=states
            ), patch.object(self.cli.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "", "")):
                result = adapters.register("codex")["codex"]
            self.assertFalse(result["registered"])
            self.assertTrue(result["mutation_may_have_happened"])
            payload = self.cli._status_payload(config, clients={"codex": result}, target="codex", connected=None)
            self.assertTrue(payload["mutation_may_have_happened"])
            self.assertFalse((config.home / "adapters" / "codex.json").exists())

    def test_codex_add_timeout_keeps_unknown_mutation_explicit(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            adapters = self.cli.ClientAdapters(config, registration_mode="official")
            with patch.object(self.cli, "_detect_command", return_value={"detected": True, "executable": "codex"}), patch.object(
                adapters, "_codex_mcp_state", side_effect=[{"status": "absent"}, {"status": "error"}]
            ), patch.object(self.cli.subprocess, "run", side_effect=subprocess.TimeoutExpired("codex add", 15)):
                result = adapters.register("codex")["codex"]
            self.assertFalse(result["registered"])
            self.assertTrue(result["mutation_may_have_happened"])

    def test_cli_jsonl_preserves_unicode_paths_through_legacy_console_pipes(self):
        payload = {"event": "installed", "command": "C:/用户/空 格/fargowork.exe"}
        output = io.StringIO()
        with patch.object(sys, "stdout", output):
            self.cli._emit_event(payload, output="jsonl")
        encoded = output.getvalue().encode("ascii")
        # Legacy Windows console decoding does not alter this byte stream.
        self.assertEqual(json.loads(encoded.decode("cp936")), payload)

    def test_manual_commands_export_bridge_and_skill_without_touching_clients(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            for name in ("plugin.json", "mcp.json"):
                (config.plugin_dir / name).write_text("{}", encoding="utf-8")
            client = self.host_home / ".cursor" / "mcp.json"
            client.parent.mkdir(parents=True)
            original = b'{"mcpServers":{"unrelated":{"command":"keep","args":[]}}}'
            client.write_bytes(original)
            identity = {"userid": "fixture-user", "corp_id": "fixture-corp"}
            with patch.object(self.cli.Config, "load", return_value=config), patch.object(
                self.cli, "_detect_command", side_effect=AssertionError("manual must not detect a client")
            ), patch.object(self.cli.subprocess, "run", side_effect=AssertionError("manual must not invoke a client")), patch.object(
                config, "secure_vault", return_value=self.cli.MemoryVault("refresh-fixture")
            ), patch.object(self.cli.TokenSession, "me", return_value=identity):
                for command, expected_exit in (("install", 0), ("doctor", 3), ("repair", 0), ("status", 3), ("uninstall", 0)):
                    out = io.StringIO()
                    with patch("sys.stdout", out):
                        result = self.cli.main([command, "--target", "manual", "--output", "jsonl"])
                    self.assertEqual(result, expected_exit, out.getvalue())
                    payload = json.loads(out.getvalue().splitlines()[-1])
                    if command == "uninstall":
                        self.assertFalse(payload["clients"]["manual"]["uninstalled"])
                        continue
                    registration = payload["manual_mcp_registration"]
                    self.assertTrue(Path(registration["command"]).is_absolute())
                    self.assertEqual(registration["args"], ["bridge"])
                    self.assertEqual(registration["protocol_versions"], ["2025-11-25"])
                    self.assertTrue(Path(registration["skill_path"]).is_file())
                    if command == "status":
                        self.assertTrue(payload["connected"])
                        self.assertTrue(payload["identity_verified"])
                    else:
                        self.assertIsNone(payload["connected"])
                        self.assertFalse(payload["identity_verified"])
                    self.assertEqual(payload["clients"]["manual"]["registered"], "unknown")
            self.assertEqual(client.read_bytes(), original)
            self.assertFalse((config.home / "adapters").exists())

    def test_cursor_merge_and_owned_uninstall_preserve_other_entries_and_preferences(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            path = self.host_home / ".cursor" / "mcp.json"
            path.parent.mkdir(parents=True)
            before = {"mcpServers": {"unrelated": {"command": "keep", "args": []}}, "unrelatedSetting": {"keep": True}}
            path.write_text(json.dumps(before), encoding="utf-8")
            preference = self.host_home / ".cursor" / "skills" / "personal-preferences" / "SKILL.md"
            preference.parent.mkdir(parents=True)
            preference.write_text("personal preferences", encoding="utf-8")
            with patch.object(self.cli, "_detect_command", return_value={"detected": True, "executable": "cursor"}), patch.object(
                self.cli.subprocess, "run", side_effect=AssertionError("Cursor registration is JSON-only")
            ):
                adapters = self.cli.ClientAdapters(config, registration_mode="official")
                installed = adapters.register("cursor")["cursor"]
                self.assertTrue(installed["registered"])
                self.assertEqual(installed["trusted"], "unknown")
                entry = json.loads(path.read_text())["mcpServers"][self.cli.PLUGIN_NAME]
                self.assertEqual(entry, {"type": "stdio", "command": adapters._native_bridge_command(), "args": ["bridge"]})
                self.assertTrue(adapters.uninstall("cursor")["cursor"]["uninstalled"])
            self.assertEqual(json.loads(path.read_text()), before)
            self.assertEqual(preference.read_text(), "personal preferences")

    def test_cursor_foreign_entry_and_modified_owned_entry_are_preserved(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            path = self.host_home / ".cursor" / "mcp.json"
            path.parent.mkdir(parents=True)
            foreign = {"mcpServers": {self.cli.PLUGIN_NAME: {"command": "foreign", "args": []}}}
            path.write_text(json.dumps(foreign), encoding="utf-8")
            original = path.read_bytes()
            with patch.object(self.cli, "_detect_command", return_value={"detected": True, "executable": "cursor"}):
                adapters = self.cli.ClientAdapters(config, registration_mode="official")
                self.assertFalse(adapters.register("cursor")["cursor"]["registered"])
                self.assertFalse(adapters.uninstall("cursor")["cursor"]["uninstalled"])
                self.assertEqual(path.read_bytes(), original)
                path.write_text("{}", encoding="utf-8")
                self.assertTrue(adapters.register("cursor")["cursor"]["registered"])
                altered = json.loads(path.read_text())
                altered["mcpServers"][self.cli.PLUGIN_NAME]["env"] = {"UNRELATED": "preserve"}
                path.write_text(json.dumps(altered), encoding="utf-8")
                altered_bytes = path.read_bytes()
                self.assertFalse(adapters.uninstall("cursor")["cursor"]["uninstalled"])
                self.assertEqual(path.read_bytes(), altered_bytes)

    def test_cursor_duplicate_keys_and_foreign_skill_fail_without_config_write(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            path = self.host_home / ".cursor" / "mcp.json"
            path.parent.mkdir(parents=True)
            raw = b'{"mcpServers":{},"mcpServers":{"other":{"command":"keep"}}}'
            path.write_bytes(raw)
            with patch.object(self.cli, "_detect_command", return_value={"detected": True, "executable": "cursor"}):
                adapters = self.cli.ClientAdapters(config, registration_mode="official")
                with self.assertRaises(self.cli.FargoWorkError):
                    adapters.register("cursor")
                self.assertEqual(path.read_bytes(), raw)
                path.write_text("{}", encoding="utf-8")
                skill = self.host_home / ".cursor" / "skills" / self.cli.PLUGIN_NAME / "SKILL.md"
                skill.parent.mkdir(parents=True)
                skill.write_text("foreign personal Skill", encoding="utf-8")
                with self.assertRaises(self.cli.FargoWorkError):
                    adapters.register("cursor")
                self.assertEqual(path.read_text(), "{}")
                self.assertEqual(skill.read_text(), "foreign personal Skill")

    def test_cursor_sidecar_write_failure_rolls_back_only_its_entry(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            path = self.host_home / ".cursor" / "mcp.json"
            path.parent.mkdir(parents=True)
            before = {"mcpServers": {"unrelated": {"command": "keep"}}}
            path.write_text(json.dumps(before), encoding="utf-8")
            atomic = self.cli._atomic_write
            def fail_sidecar(target, data, **kwargs):
                if target == config.home / "adapters" / "cursor.json":
                    raise OSError("fixture sidecar failure")
                return atomic(target, data, **kwargs)
            with patch.object(self.cli, "_detect_command", return_value={"detected": True, "executable": "cursor"}), patch.object(
                self.cli, "_atomic_write", side_effect=fail_sidecar
            ):
                with self.assertRaises(OSError):
                    self.cli.ClientAdapters(config, registration_mode="official").register("cursor")
            self.assertEqual(json.loads(path.read_text()), before)

    def test_claude_code_cli_user_registration_and_uninstall_preserve_other_data(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            path = self.host_home / ".claude.json"
            before = {"mcpServers": {"other": {"command": "keep"}}, "personalPreference": "preserve"}
            path.write_text(json.dumps(before), encoding="utf-8")
            calls = []
            def run(argv, **kwargs):
                calls.append(list(argv))
                payload = json.loads(path.read_text())
                if argv[1:3] == ["mcp", "get"]:
                    exists = self.cli.PLUGIN_NAME in payload["mcpServers"]
                    return subprocess.CompletedProcess(argv, 0 if exists else 1, "present" if exists else "", "" if exists else "No MCP server found with name")
                if argv[1:3] == ["mcp", "add"]:
                    self.assertEqual(argv[3:9], ["--transport", "stdio", "--scope", "user", self.cli.PLUGIN_NAME, "--"])
                    payload["mcpServers"][self.cli.PLUGIN_NAME] = {"type": "stdio", "command": argv[9], "args": argv[10:]}
                elif argv[1:3] == ["mcp", "remove"]:
                    self.assertEqual(argv[3:], ["--scope", "user", self.cli.PLUGIN_NAME])
                    del payload["mcpServers"][self.cli.PLUGIN_NAME]
                else:
                    raise AssertionError(argv)
                path.write_text(json.dumps(payload), encoding="utf-8")
                return subprocess.CompletedProcess(argv, 0, "", "")
            with patch.object(self.cli, "_detect_command", return_value={"detected": True, "executable": "claude"}), patch.object(
                self.cli.subprocess, "run", side_effect=run
            ):
                adapters = self.cli.ClientAdapters(config, registration_mode="official")
                result = adapters.register("claude-code")["claude-code"]
                self.assertTrue(result["registered"])
                self.assertEqual(result["trusted"], "unknown")
                self.assertTrue(adapters.uninstall("claude-code")["claude-code"]["uninstalled"])
            self.assertEqual(json.loads(path.read_text()), before)
            self.assertEqual(sum(command[1:3] == ["mcp", "add"] for command in calls), 1)

    def test_known_host_conflict_returns_nonzero_without_fake_connection(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            for name in ("plugin.json", "mcp.json"):
                (config.plugin_dir / name).write_text("{}", encoding="utf-8")
            path = self.host_home / ".cursor" / "mcp.json"
            path.parent.mkdir(parents=True)
            raw = b'{"mcpServers":{"fargowork-employee":{"command":"foreign","args":[]}}}'
            path.write_bytes(raw)
            with patch.object(self.cli.Config, "load", return_value=config), patch.object(
                self.cli, "_detect_command", return_value={"detected": True, "executable": "cursor"}
            ):
                for command in ("install", "repair"):
                    out = io.StringIO()
                    with patch("sys.stdout", out):
                        result = self.cli.main([command, "--target", "cursor", "--output", "jsonl"])
                    self.assertEqual(result, self.cli.EXIT_NEEDS_ACTION)
                    payload = json.loads(out.getvalue().splitlines()[-1])
                    self.assertIsNone(payload["connected"])
                    self.assertFalse(payload["identity_verified"])
            self.assertEqual(path.read_bytes(), raw)

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
            with patch.object(self.cli, "_detect_command", return_value={"detected": True, "executable": "cursor"}):
                adapters = self.cli.ClientAdapters(config, registration_mode="official")
                self.assertTrue(adapters.register("cursor")["cursor"]["registered"])
                host_skill = adapters._host_skill_path("cursor") / "SKILL.md"
                host_skill.write_bytes(changed)
                with self.assertRaises(self.cli.FargoWorkError):
                    adapters.register("cursor")
                self.assertEqual(host_skill.read_bytes(), changed)

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

    def test_claude_sidecar_failure_removes_only_new_user_entry(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            path = self.host_home / ".claude.json"
            before = {"mcpServers": {"unrelated": {"command": "keep"}}, "personalPreference": "keep"}
            path.write_text(json.dumps(before), encoding="utf-8")
            calls = []
            def run(argv, **kwargs):
                calls.append(list(argv))
                payload = json.loads(path.read_text())
                if argv[1:3] == ["mcp", "get"]:
                    exists = self.cli.PLUGIN_NAME in payload["mcpServers"]
                    return subprocess.CompletedProcess(argv, 0 if exists else 1, "present" if exists else "", "" if exists else "No MCP server found with name")
                if argv[1:3] == ["mcp", "add"]:
                    payload["mcpServers"][self.cli.PLUGIN_NAME] = {"type": "stdio", "command": argv[9], "args": argv[10:]}
                elif argv[1:3] == ["mcp", "remove"]:
                    self.assertEqual(argv[3:], ["--scope", "user", self.cli.PLUGIN_NAME])
                    del payload["mcpServers"][self.cli.PLUGIN_NAME]
                else:
                    raise AssertionError(argv)
                path.write_text(json.dumps(payload), encoding="utf-8")
                return subprocess.CompletedProcess(argv, 0, "", "")
            atomic = self.cli._atomic_write
            def fail_sidecar(target, data, **kwargs):
                if target == config.home / "adapters" / "claude-code.json":
                    raise OSError("fixture sidecar failure")
                return atomic(target, data, **kwargs)
            with patch.object(self.cli, "_detect_command", return_value={"detected": True, "executable": "claude"}), patch.object(
                self.cli.subprocess, "run", side_effect=run
            ), patch.object(self.cli, "_atomic_write", side_effect=fail_sidecar):
                with self.assertRaises(OSError):
                    self.cli.ClientAdapters(config, registration_mode="official").register("claude-code")
            self.assertEqual(json.loads(path.read_text()), before)
            self.assertEqual(sum(command[1:3] == ["mcp", "remove"] for command in calls), 1)

    def test_codex_sidecar_failure_rolls_back_exact_new_native_registration(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            state = {}
            calls = []
            atomic = self.cli._atomic_write
            def fail_sidecar(target, data, **kwargs):
                if target == config.home / "adapters" / "codex.json":
                    raise OSError("fixture sidecar failure")
                return atomic(target, data, **kwargs)
            with patch.object(self.cli, "_detect_command", return_value={"detected": True, "executable": "codex"}), patch.object(
                self.cli.subprocess, "run", side_effect=self.codex_cli_stub(config, state, calls)
            ), patch.object(self.cli, "_atomic_write", side_effect=fail_sidecar):
                with self.assertRaises(OSError):
                    self.cli.ClientAdapters(config, registration_mode="official").register("codex")
            self.assertEqual(state, {})
            self.assertEqual(sum(command[1:3] == ["mcp", "remove"] for command in calls), 1)

    def test_workbuddy_sidecar_failure_rolls_back_only_new_user_registration(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            state = {"other": "preserve"}
            calls = []
            adapters = self.cli.ClientAdapters(config, registration_mode="official")
            def run(argv, **kwargs):
                calls.append(list(argv))
                if argv[1:3] == ["mcp", "get"]:
                    if self.cli.PLUGIN_NAME in state:
                        return subprocess.CompletedProcess(argv, 0, adapters._bridge_command() + " bridge", "")
                    return subprocess.CompletedProcess(argv, 1, "", "not found in any scope")
                if argv[1:3] == ["mcp", "add"]:
                    state[self.cli.PLUGIN_NAME] = True
                elif argv[1:3] == ["mcp", "remove"]:
                    self.assertEqual(argv[3:], ["-s", "user", self.cli.PLUGIN_NAME])
                    del state[self.cli.PLUGIN_NAME]
                else:
                    raise AssertionError(argv)
                return subprocess.CompletedProcess(argv, 0, "", "")
            atomic = self.cli._atomic_write
            def fail_sidecar(target, data, **kwargs):
                if target == config.home / "adapters" / "workbuddy.json":
                    raise OSError("fixture sidecar failure")
                return atomic(target, data, **kwargs)
            with patch.object(self.cli, "_detect_command", return_value={"detected": True, "executable": "codebuddy"}), patch.object(
                self.cli.subprocess, "run", side_effect=run
            ), patch.object(self.cli, "_atomic_write", side_effect=fail_sidecar):
                with self.assertRaises(OSError):
                    adapters.register("workbuddy")
            self.assertEqual(state, {"other": "preserve"})
            self.assertEqual(sum(command[1:3] == ["mcp", "remove"] for command in calls), 1)

    def test_fixture_ownership_reports_and_uninstalls_only_owned_entry(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.development_config(Path(temp))
            adapters = self.cli.ClientAdapters(config)
            result = adapters.register("codex")["codex"]
            self.assertTrue(result["registered"])
            self.assertEqual(adapters.codex()["registration"], "fargowork-owned-fixture")
            removed = adapters.uninstall("codex")["codex"]
            self.assertTrue(removed["uninstalled"])
            self.assertFalse((Path(os.environ["CODEX_HOME"]) / "skills" / "fargowork-employee").exists())

    def test_codex_install_deploys_core_skill_and_preserves_foreign_skill(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            home = Path(temp)
            config = self.development_config(home)
            adapters = self.cli.ClientAdapters(config)
            installed = adapters.register("codex")["codex"]
            skill_path = Path(os.environ["CODEX_HOME"]) / "skills" / "fargowork-employee"
            self.assertTrue(installed["skill"]["managed"])
            self.assertEqual((skill_path / "SKILL.md").read_text(encoding="utf-8"), "---\nname: fargowork\n---\n")

            adapters.uninstall("codex")
            skill_path.mkdir(parents=True)
            (skill_path / "SKILL.md").write_text("foreign skill", encoding="utf-8")
            with self.assertRaisesRegex(self.cli.FargoWorkError, "non-FargoWork Codex Skill"):
                adapters.register("codex")
            self.assertEqual((skill_path / "SKILL.md").read_text(encoding="utf-8"), "foreign skill")

    def test_codex_target_status_and_doctor_ignore_workbuddy_state(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            home = Path(temp)
            config = self.config(home)
            config.plugin_dir.mkdir(parents=True, exist_ok=True)
            (config.plugin_dir / "plugin.json").write_text("{}", encoding="utf-8")
            (config.plugin_dir / "mcp.json").write_text("{}", encoding="utf-8")
            codex = {
                "detected": True,
                "registered": True,
                "trusted": True,
                "needs_user_action": False,
                "registration": "official-codex-cli",
            }
            status = self.cli._status_payload(
                config, clients={"codex": codex}, target="codex", connected=True
            )
            self.assertFalse(status["needs_user_action"])
            self.assertTrue(status["trusted"])
            self.assertEqual(set(status["clients"]), {"codex"})
            manual = status["manual_mcp_registration"]
            self.assertEqual(manual["transport"], "stdio")
            self.assertEqual(manual["args"], ["bridge"])
            self.assertTrue(Path(manual["command"]).is_absolute())
            self.assertEqual(
                manual["config"]["mcpServers"]["fargowork-employee"]["command"],
                manual["command"],
            )
            self.assertEqual(
                status["compatibility"],
                {
                    "mcp_protocol_versions": ["2026-07-28"],
                    "agent_plugins_spec": "1.0.0",
                    "action_result_contract": 1,
                },
            )

            adapters = SimpleNamespace(selected=lambda target: {target: codex})
            vault = SimpleNamespace(get=lambda: "refresh-present")
            with patch.object(self.cli, "ClientAdapters", return_value=adapters), patch.object(
                config, "secure_vault", return_value=vault
            ):
                doctor = self.cli._doctor(config, target="codex")
            self.assertEqual(doctor["status"], "ready")
            self.assertNotIn("workbuddy_trust", doctor["checks"])
            self.assertEqual(
                doctor["manual_mcp_registration"],
                status["manual_mcp_registration"],
            )

            all_status = self.cli._status_payload(
                config,
                clients={
                    "codex": codex,
                    "cursor": {
                        "detected": False,
                        "registered": False,
                        "trusted": False,
                        "needs_user_action": True,
                    },
                },
                target="all",
                connected=True,
            )
            self.assertFalse(all_status["needs_user_action"])

    def test_human_status_prints_generic_manual_registration_without_clipboard_side_effect(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            payload = {
                "event": "status",
                "status": "ready",
                "manual_mcp_registration": self.cli._manual_mcp_registration(config),
            }
            output = io.StringIO()
            with patch("sys.stdout", output):
                self.cli._emit_event(payload, output="human")

            rendered = output.getvalue()
            self.assertIn("manual_mcp_registration", rendered)
            self.assertIn('"mcpServers"', rendered)
            self.assertIn('"bridge"', rendered)
            self.assertNotIn("token", rendered.lower())

    def test_selected_adapter_probes_only_requested_client(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            adapters = self.cli.ClientAdapters(self.config(Path(temp)))
            with patch.object(adapters, "codex", return_value={"registered": True}) as codex, patch.object(
                adapters, "workbuddy", side_effect=AssertionError("unexpected WorkBuddy probe")
            ), patch.object(adapters, "cursor", side_effect=AssertionError("unexpected Cursor probe")):
                self.assertEqual(adapters.selected("codex"), {"codex": {"registered": True}})
            codex.assert_called_once_with()

    def test_official_codex_registration_and_cursor_json_are_isolated(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            calls = []
            state = {}
            stub = self.codex_cli_stub(config, state, calls)

            def detect(name):
                return {"detected": name == "codex", "executable": name if name == "codex" else None}

            with patch.object(self.cli, "_detect_command", side_effect=detect), patch.object(self.cli.subprocess, "run", side_effect=stub):
                adapters = self.cli.ClientAdapters(config, registration_mode="official")
                result = adapters.register("codex")["codex"]
                self.assertTrue(result["registered"])
                self.assertEqual(json.loads((Path(temp) / "adapters" / "codex.json").read_text())["registration"], "official-codex-cli")
                self.assertEqual(state[self.cli.PLUGIN_NAME]["transport"]["args"], ["bridge"])
                self.assertEqual(state[self.cli.PLUGIN_NAME]["transport"]["env"], {})
                self.assertEqual(state[self.cli.PLUGIN_NAME]["transport"]["env_vars"], [])
                adapters.register("codex")
                self.assertEqual(sum(call[1:4] == ["mcp", "add", self.cli.PLUGIN_NAME] for call in calls), 1)

            with patch.object(self.cli, "_detect_command", return_value={"detected": True, "executable": "cursor"}), patch.object(
                self.cli.subprocess, "run", side_effect=AssertionError("Cursor JSON registration must not invoke a CLI")
            ) as cursor_run:
                cursor = self.cli.ClientAdapters(config, registration_mode="official")
                cursor_result = cursor.register("cursor")["cursor"]
            self.assertTrue(cursor_result["detected"])
            self.assertTrue(cursor_result["registered"])
            self.assertEqual(cursor_result["registration"], "official-cursor-user-json")
            installed = json.loads((self.host_home / ".cursor" / "mcp.json").read_text())
            self.assertEqual(installed["mcpServers"][self.cli.PLUGIN_NAME]["args"], ["bridge"])
            cursor_run.assert_not_called()

    def test_codex_inventory_and_get_override_sidecar_shortcuts_and_preserve_conflicts(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            home = Path(temp)
            config = self.config(home)
            adapters = self.cli.ClientAdapters(config, registration_mode="official")
            sidecar_path = home / "adapters" / "codex.json"
            sidecar_path.parent.mkdir(parents=True)
            sidecar_path.write_text(json.dumps({
                **adapters._fixture_payload(),
                "env": {},
                "registration": "official-codex-cli",
            }), encoding="utf-8")
            calls = []
            state = {}
            stub = self.codex_cli_stub(config, state, calls)
            with patch.object(self.cli, "_detect_command", return_value={"detected": True, "executable": "codex"}), patch.object(
                self.cli.subprocess, "run", side_effect=stub
            ):
                missing = adapters.codex()
                self.assertFalse(missing["registered"])
                self.assertEqual(missing["registration"], "registration_missing")
                repaired = adapters.register("codex")["codex"]
                self.assertTrue(repaired["registered"])
                self.assertEqual(sum(call[1:4] == ["mcp", "add", self.cli.PLUGIN_NAME] for call in calls), 1)

                state[self.cli.PLUGIN_NAME]["enabled"] = False
                disabled = adapters.codex()
                self.assertFalse(disabled["registered"])
                self.assertEqual(disabled["registration"], "conflict")
                state[self.cli.PLUGIN_NAME]["enabled"] = True

                state[self.cli.PLUGIN_NAME]["transport"]["cwd"] = "C:/alternate-working-directory"
                changed_cwd = adapters.codex()
                self.assertFalse(changed_cwd["registered"])
                self.assertEqual(changed_cwd["registration"], "conflict")
                state[self.cli.PLUGIN_NAME]["transport"]["cwd"] = None
                state[self.cli.PLUGIN_NAME]["transport"]["env_vars"] = ["FARGOWORK_ISSUER"]
                changed_env_names = adapters.codex()
                self.assertFalse(changed_env_names["registered"])
                self.assertEqual(changed_env_names["registration"], "conflict")
                state[self.cli.PLUGIN_NAME]["transport"]["env_vars"] = []
                state[self.cli.PLUGIN_NAME]["transport"]["env"] = {"FARGOWORK_ISSUER": "https://changed.example.invalid"}
                changed = adapters.codex()
                self.assertFalse(changed["registered"])
                self.assertEqual(changed["registration"], "conflict")
                removed = adapters.uninstall("codex")["codex"]
                self.assertFalse(removed["uninstalled"])
                self.assertIn(self.cli.PLUGIN_NAME, state)
                self.assertTrue(sidecar_path.exists())
                self.assertFalse(any(call[1:4] == ["mcp", "remove", self.cli.PLUGIN_NAME] for call in calls))

    def test_codex_real_get_shape_is_required_and_malformed_get_cannot_look_absent(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            home = Path(temp)
            config = self.config(home)
            adapters = self.cli.ClientAdapters(config, registration_mode="official")
            expected = self.codex_entry(config)
            parsed = adapters._codex_get_entry(expected, self.cli.PLUGIN_NAME)
            self.assertEqual(parsed["transport"]["type"], "stdio")
            self.assertTrue(parsed["enabled"])

            flat_fake = {
                "name": self.cli.PLUGIN_NAME,
                "enabled": True,
                "command": expected["transport"]["command"],
                "args": ["bridge"],
                "env": {},
            }
            with self.assertRaises(ValueError):
                adapters._codex_get_entry(flat_fake, self.cli.PLUGIN_NAME)

            state = {self.cli.PLUGIN_NAME: expected}
            calls = []

            def malformed_get(argv, **_kwargs):
                command = list(argv)
                calls.append(command)
                if command[1:4] == ["mcp", "list", "--json"]:
                    return subprocess.CompletedProcess(command, 0, json.dumps(list(state.values())), "")
                if command[1:4] == ["mcp", "get", self.cli.PLUGIN_NAME] and command[4:5] == ["--json"]:
                    return subprocess.CompletedProcess(command, 0, "not-json", "")
                raise AssertionError(f"unexpected Codex mutation after malformed get: {command}")

            with patch.object(self.cli, "_detect_command", return_value={"detected": True, "executable": "codex"}), patch.object(
                self.cli.subprocess, "run", side_effect=malformed_get
            ):
                result = adapters.register("codex")["codex"]

            self.assertFalse(result["registered"])
            self.assertEqual(result["registration"], "official-cli-error")
            self.assertIn(self.cli.PLUGIN_NAME, state)
            self.assertFalse(any(call[1:4] == ["mcp", "add", self.cli.PLUGIN_NAME] for call in calls))

    def test_codex_same_name_without_owned_sidecar_is_not_adopted_or_removed(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            home = Path(temp)
            config = self.config(home)
            adapters = self.cli.ClientAdapters(config, registration_mode="official")
            state = {self.cli.PLUGIN_NAME: self.codex_entry(config, command="C:/someone-else/fargowork.cmd")}
            calls = []
            stub = self.codex_cli_stub(config, state, calls)
            with patch.object(self.cli, "_detect_command", return_value={"detected": True, "executable": "codex"}), patch.object(
                self.cli.subprocess, "run", side_effect=stub
            ):
                registered = adapters.register("codex")["codex"]
                self.assertFalse(registered["registered"])
                self.assertEqual(registered["registration"], "conflict")
                removed = adapters.uninstall("codex")["codex"]
                self.assertTrue(removed["uninstalled"])  # only the FargoWork-owned Skill was cleaned up
            self.assertEqual(state[self.cli.PLUGIN_NAME]["transport"]["command"], "C:/someone-else/fargowork.cmd")
            self.assertFalse(any(call[1:4] == ["mcp", "add", self.cli.PLUGIN_NAME] for call in calls))
            self.assertFalse(any(call[1:4] == ["mcp", "remove", self.cli.PLUGIN_NAME] for call in calls))

    def test_codex_unreadable_inventory_fails_closed_for_registration_and_uninstall(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            home = Path(temp)
            config = self.config(home)
            adapters = self.cli.ClientAdapters(config, registration_mode="official")
            sidecar_path = home / "adapters" / "codex.json"
            sidecar_path.parent.mkdir(parents=True)
            sidecar_path.write_text(json.dumps({
                **adapters._fixture_payload(),
                "env": {},
                "registration": "official-codex-cli",
            }), encoding="utf-8")
            calls = []

            def unreadable_inventory(argv, **_kwargs):
                command = list(argv)
                calls.append(command)
                if command[1:4] == ["mcp", "list", "--json"]:
                    return subprocess.CompletedProcess(command, 0, "not-json", "")
                raise AssertionError(f"unexpected Codex mutation or get after unreadable inventory: {command}")

            with patch.object(self.cli, "_detect_command", return_value={"detected": True, "executable": "codex"}), patch.object(
                self.cli.subprocess, "run", side_effect=unreadable_inventory
            ):
                registered = adapters.register("codex")["codex"]
                removed = adapters.uninstall("codex")["codex"]
            self.assertFalse(registered["registered"])
            self.assertEqual(registered["registration"], "official-cli-error")
            self.assertFalse(removed["uninstalled"])
            self.assertTrue(sidecar_path.exists())
            self.assertEqual(len(calls), 3)  # inventory was retried for status; no add/get/remove occurred

    def test_codex_uninstall_removes_only_exact_owned_native_entry(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            home = Path(temp)
            config = self.config(home)
            adapters = self.cli.ClientAdapters(config, registration_mode="official")
            sidecar_path = home / "adapters" / "codex.json"
            sidecar_path.parent.mkdir(parents=True)
            sidecar_path.write_text(json.dumps({
                **adapters._fixture_payload(),
                "env": {},
                "cwd": None,
                "registration": "official-codex-cli",
            }), encoding="utf-8")
            state = {self.cli.PLUGIN_NAME: self.codex_entry(config)}
            calls = []
            stub = self.codex_cli_stub(config, state, calls)
            with patch.object(self.cli, "_detect_command", return_value={"detected": True, "executable": "codex"}), patch.object(
                self.cli.subprocess, "run", side_effect=stub
            ):
                removed = adapters.uninstall("codex")["codex"]
            self.assertTrue(removed["uninstalled"])
            self.assertNotIn(self.cli.PLUGIN_NAME, state)
            self.assertFalse(sidecar_path.exists())
            self.assertEqual(sum(call[1:4] == ["mcp", "remove", self.cli.PLUGIN_NAME] for call in calls), 1)

    def test_employee_registration_rejects_fixture_flag_and_environment_override(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            with self.assertRaises(self.cli.FargoWorkError) as explicit:
                self.cli.ClientAdapters(config, registration_mode="fixture")
            self.assertEqual(explicit.exception.code, "invalid_registration_mode")
            with patch.dict(os.environ, {"FARGOWORK_CLIENT_REGISTRATION_MODE": "fixture"}):
                adapters = self.cli.ClientAdapters(config)
                self.assertEqual(adapters.registration_mode, "official")
                output = io.StringIO()
                with patch.object(self.cli.Config, "load", return_value=config), patch("sys.stdout", output):
                    self.assertEqual(self.cli.main(["version", "--output", "jsonl"]), self.cli.EXIT_OK)
                self.assertIn('"event":"version"', output.getvalue())
            for command in ("install", "repair"):
                with self.assertRaises(SystemExit) as parse_error:
                    self.cli._build_parser().parse_args([command, "--registration-mode", "fixture"])
                self.assertEqual(parse_error.exception.code, 2)

    def test_employee_codex_status_does_not_trust_fixture_sidecar(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            home = Path(temp)
            config = self.config(home)
            adapters = self.cli.ClientAdapters(config, registration_mode="official")
            path = home / "adapters" / "codex.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps(adapters._fixture_payload()), encoding="utf-8")
            calls = []
            state = {}
            with patch.object(self.cli, "_detect_command", return_value={"detected": True, "executable": "codex"}), patch.object(
                self.cli.subprocess, "run", side_effect=self.codex_cli_stub(config, state, calls)
            ), patch.object(config, "secure_vault", return_value=SimpleNamespace(get=lambda: "refresh-present")):
                status = adapters.codex()
                doctor = self.cli._doctor(config, target="codex")
                self.assertEqual(doctor["status"], "needs_user_action")
                self.assertFalse(doctor["clients"]["codex"]["registered"])
                repaired = adapters.register("codex")["codex"]
            self.assertFalse(status["registered"])
            self.assertFalse(status["trusted"])
            self.assertEqual(status["registration"], "not_registered")
            self.assertTrue(repaired["registered"])
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["registration"], "official-codex-cli")

    def test_employee_uninstall_does_not_use_fixture_sidecar_to_remove_native_entry(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            home = Path(temp)
            config = self.config(home)
            adapters = self.cli.ClientAdapters(config, registration_mode="official")
            path = home / "adapters" / "codex.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps(adapters._fixture_payload()), encoding="utf-8")
            state = {self.cli.PLUGIN_NAME: self.codex_entry(config)}
            calls = []
            with patch.object(self.cli, "_detect_command", return_value={"detected": True, "executable": "codex"}), patch.object(
                self.cli.subprocess, "run", side_effect=self.codex_cli_stub(config, state, calls)
            ):
                removed = adapters.uninstall("codex")["codex"]
            self.assertFalse(removed["uninstalled"])
            self.assertIn(self.cli.PLUGIN_NAME, state)
            self.assertTrue(path.exists())
            self.assertFalse(any(call[1:4] == ["mcp", "remove", self.cli.PLUGIN_NAME] for call in calls))

    def test_official_codebuddy_user_registration_is_idempotent_and_owned(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            home = Path(temp)
            config = self.config(home)
            calls = []
            state = {"registered": False}
            launcher = config.plugin_dir / "bin" / ("fargowork.cmd" if self.cli.platform.system() == "Windows" else "fargowork-employee")

            def detect(*names):
                if names == ("codebuddy",):
                    return {"detected": True, "executable": "codebuddy"}
                return {"detected": False, "executable": None}

            def run(argv, **_kwargs):
                calls.append(list(argv))
                if argv[1:4] == ["mcp", "get", "fargowork-employee"]:
                    if state["registered"]:
                        return SimpleNamespace(returncode=0, stdout=f"name=fargowork command={launcher} bridge", stderr="")
                    return SimpleNamespace(returncode=0, stdout="", stderr='MCP server "fargowork-employee" not found in any scope')
                if argv[1:4] == ["mcp", "add", "fargowork-employee"]:
                    state["registered"] = True
                    return SimpleNamespace(returncode=0, stdout="", stderr="")
                if argv[1:5] == ["mcp", "remove", "-s", "user"]:
                    state["registered"] = False
                    return SimpleNamespace(returncode=0, stdout="", stderr="")
                raise AssertionError(argv)

            with patch.object(self.cli, "_detect_command", side_effect=detect), patch.object(self.cli.subprocess, "run", side_effect=run):
                adapters = self.cli.ClientAdapters(config, registration_mode="official")
                first = adapters.register("workbuddy")["workbuddy"]
                self.assertTrue(first["registered"])
                self.assertEqual(first["registration"], "official-codebuddy-user")
                add_calls = [call for call in calls if call[1:4] == ["mcp", "add", "fargowork-employee"]]
                self.assertEqual(len(add_calls), 1)
                self.assertEqual(add_calls[0][4:10], ["-s", "user", "-t", "stdio", "--", str(launcher)])
                second = adapters.register("workbuddy")["workbuddy"]
                self.assertTrue(second["registered"])
                self.assertEqual(len([call for call in calls if call[1:4] == ["mcp", "add", "fargowork-employee"]]), 1)
                removed = adapters.uninstall("workbuddy")["workbuddy"]
                self.assertTrue(removed["uninstalled"])
                remove_calls = [call for call in calls if call[1:6] == ["mcp", "remove", "-s", "user", "fargowork-employee"]]
                self.assertEqual(len(remove_calls), 1)
                self.assertFalse((home / "adapters" / "workbuddy.json").exists())

    def test_codebuddy_conflict_is_preserved_and_not_removed(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            home = Path(temp)
            config = self.config(home)
            path = home / "adapters" / "workbuddy.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({"owner": "another-client", "command": "keep-me"}), encoding="utf-8")

            def detect(*names):
                if names == ("codebuddy",):
                    return {"detected": True, "executable": "codebuddy"}
                return {"detected": False, "executable": None}

            def run(argv, **_kwargs):
                if argv[1:4] == ["mcp", "get", "fargowork-employee"]:
                    return SimpleNamespace(returncode=0, stdout="name=fargowork command=C:\\someone\\else\\fargowork bridge", stderr="")
                raise AssertionError(argv)

            with patch.object(self.cli, "_detect_command", side_effect=detect), patch.object(self.cli.subprocess, "run", side_effect=run) as mocked:
                adapters = self.cli.ClientAdapters(config, registration_mode="official")
                result = adapters.register("workbuddy")["workbuddy"]
                self.assertFalse(result["registered"])
                self.assertEqual(result["registration"], "conflict")
                self.assertEqual(json.loads(path.read_text())["command"], "keep-me")
                removed = adapters.uninstall("workbuddy")["workbuddy"]
                self.assertFalse(removed["uninstalled"])
                self.assertEqual(len(mocked.call_args_list), 3)
                self.assertFalse(any(call.args[0][1:3] == ["mcp", "remove"] for call in mocked.call_args_list))

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
