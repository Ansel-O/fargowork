import importlib.util
import io
import json
import os
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
            elif body.get("refresh_token") == ["refresh-1"]:
                self.send_json(200, {"access_token": "access-2", "token_type": "Bearer", "expires_in": 600, "refresh_token": "refresh-2", "scope": "fargowork:mcp"})
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
                payload = {"supportedVersions": ["2026-07-28"], "capabilities": {"tools": {"listChanged": False}}, "serverInfo": {"name": "fixture", "version": "1"}}
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
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.codex_temp = __import__("tempfile").TemporaryDirectory()
        self.codex_env = patch.dict(os.environ, {"CODEX_HOME": self.codex_temp.name})
        self.codex_env.start()

    def tearDown(self):
        self.codex_env.stop()
        self.codex_temp.cleanup()

    def config(self, home):
        config = self.cli.Config(
            home=home,
            issuer=self.base,
            resource=f"{self.base}/mcp",
            resource_metadata_uri=f"{self.base}/.well-known/oauth-protected-resource",
            plugin_dir=home / "plugin" / "fargowork",
        )
        skill = config.plugin_dir / "skills" / "fargowork"
        skill.mkdir(parents=True, exist_ok=True)
        (skill / "SKILL.md").write_text("---\nname: fargowork\n---\n", encoding="utf-8")
        return config

    def test_release_defaults_to_the_office_pilot_and_keeps_loopback_redirect(self):
        self.assertEqual(self.cli.DEFAULT_ISSUER, "https://fargowork.ansel.vip")
        self.assertEqual(self.cli.DEFAULT_RESOURCE, "https://fargowork.ansel.vip/mcp")
        self.assertEqual(
            self.cli.DEFAULT_RESOURCE_METADATA_URI,
            "https://fargowork.ansel.vip/.well-known/oauth-protected-resource",
        )
        self.assertEqual(
            self.cli.DEFAULT_REDIRECT_URI,
            "http://127.0.0.1:37680/oauth/callback",
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

                with patch.object(self.cli, "_emit_event", side_effect=capture):
                    worker_error = []

                    def run_login():
                        try:
                            session.login(browser="never", timeout=10)
                        except Exception as exc:  # pragma: no cover - assertion below reports it
                            worker_error.append(exc)

                    worker = threading.Thread(target=run_login)
                    worker.start()
                    deadline = time.time() + 3
                    while not events and time.time() < deadline:
                        time.sleep(0.01)
                    self.assertTrue(events)
                    query = parse_qs(urlsplit(events[0]["url"]).query)
                    self.assertEqual(query["code_challenge_method"], ["S256"])
                    self.assertTrue(query["code_challenge"][0])
                    callback = f"{config.redirect_uri}?code=fixture-code&state={query['state'][0]}&iss={config.issuer}"
                    with urlopen(callback, timeout=3):
                        pass
                    worker.join(5)
                    self.assertFalse(worker_error, worker_error)
                self.assertEqual(vault.get(), "refresh-1")
                self.assertEqual(session.me()["userid"], "fixture-user")
                self.assertEqual(session.refresh(), "access-2")
                self.assertEqual(vault.get(), "refresh-2")
                self.assertTrue(session.access_token)
                self.assertNotIn("access-1", json.dumps(events))

    def test_bridge_translates_initialize_and_retries_one_401_without_leaking_tokens(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            session = self.cli.TokenSession(config, vault=self.cli.MemoryVault("refresh-1"), access_token="access-1", access_expires_at=time.time() + 300)
            self.server.fail_tools_list_once = True
            input_stream = io.StringIO(
                json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}) + "\n"
                + json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}) + "\n"
                + json.dumps({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "fixture_tool", "arguments": {}}}) + "\n"
                + json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}) + "\n"
            )
            output_stream = io.StringIO()
            exit_code = self.cli.run_bridge(session, input_stream=input_stream, output_stream=output_stream)
            self.assertEqual(exit_code, 0)
            responses = [json.loads(line) for line in output_stream.getvalue().splitlines()]
            self.assertEqual([response["id"] for response in responses], [1, 2, 3])
            self.assertEqual(responses[0]["result"]["protocolVersion"], "2026-07-28")
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
            self.assertNotIn("access-1", output_stream.getvalue())
            self.assertNotIn("refresh-1", output_stream.getvalue())

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
                with self.assertRaises(self.cli.FargoWorkError):
                    session.logout()
            self.assertIsNone(vault.get())
            self.assertIsNone(session.access_token)

    def test_adapter_ownership_preserves_foreign_entry(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            home = Path(temp)
            config = self.config(home)
            adapters = self.cli.ClientAdapters(config)
            adapters.register("codex")
            path = home / "adapters" / "codex.json"
            self.assertEqual(json.loads(path.read_text())["owner"], self.cli.MARKER)
            path.write_text(json.dumps({"owner": "other-client", "command": "keep-me"}), encoding="utf-8")
            result = adapters.register("codex")["codex"]
            self.assertFalse(result["registered"])
            self.assertEqual(json.loads(path.read_text())["command"], "keep-me")

    def test_fixture_ownership_reports_and_uninstalls_only_owned_entry(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            adapters = self.cli.ClientAdapters(config)
            result = adapters.register("codex")["codex"]
            self.assertTrue(result["registered"])
            self.assertEqual(adapters.codex()["registration"], "fargowork-owned-fixture")
            removed = adapters.uninstall("codex")["codex"]
            self.assertTrue(removed["uninstalled"])
            self.assertFalse((Path(os.environ["CODEX_HOME"]) / "skills" / "fargowork").exists())

    def test_codex_install_deploys_core_skill_and_preserves_foreign_skill(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            home = Path(temp)
            config = self.config(home)
            adapters = self.cli.ClientAdapters(config)
            installed = adapters.register("codex")["codex"]
            skill_path = Path(os.environ["CODEX_HOME"]) / "skills" / "fargowork"
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
                manual["config"]["mcpServers"]["fargowork"]["command"],
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
                self.cli, "SecureVault", return_value=vault
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

    def test_official_codex_registration_uses_verified_cli_and_cursor_stays_detect_only(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            with patch.object(self.cli, "_detect_command", return_value={"detected": True, "executable": "codex"}), patch.object(
                self.cli.subprocess,
                "run",
                side_effect=[SimpleNamespace(returncode=1), SimpleNamespace(returncode=0)],
            ) as run:
                adapters = self.cli.ClientAdapters(config, registration_mode="official")
                result = adapters.register("codex")["codex"]
                self.assertTrue(result["registered"])
                self.assertEqual(json.loads((Path(temp) / "adapters" / "codex.json").read_text())["registration"], "official-codex-cli")
                self.assertEqual(run.call_args_list[1].args[0][1:4], ["mcp", "add", "fargowork"])

            cursor = self.cli.ClientAdapters(config, registration_mode="official")
            cursor_result = cursor.register("cursor")["cursor"]
            self.assertFalse(cursor_result["registered"])
            self.assertEqual(cursor_result["registration"], "official-cli-detect-only")

    def test_official_codebuddy_user_registration_is_idempotent_and_owned(self):
        with __import__("tempfile").TemporaryDirectory() as temp:
            home = Path(temp)
            config = self.config(home)
            calls = []
            state = {"registered": False}
            launcher = config.plugin_dir / "bin" / ("fargowork.cmd" if self.cli.platform.system() == "Windows" else "fargowork")

            def detect(*names):
                if names == ("codebuddy",):
                    return {"detected": True, "executable": "codebuddy"}
                return {"detected": False, "executable": None}

            def run(argv, **_kwargs):
                calls.append(list(argv))
                if argv[1:4] == ["mcp", "get", "fargowork"]:
                    if state["registered"]:
                        return SimpleNamespace(returncode=0, stdout=f"name=fargowork command={launcher} bridge", stderr="")
                    return SimpleNamespace(returncode=0, stdout="", stderr='MCP server "fargowork" not found in any scope')
                if argv[1:4] == ["mcp", "add", "fargowork"]:
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
                add_calls = [call for call in calls if call[1:4] == ["mcp", "add", "fargowork"]]
                self.assertEqual(len(add_calls), 1)
                self.assertEqual(add_calls[0][4:10], ["-s", "user", "-t", "stdio", "--", str(launcher)])
                second = adapters.register("workbuddy")["workbuddy"]
                self.assertTrue(second["registered"])
                self.assertEqual(len([call for call in calls if call[1:4] == ["mcp", "add", "fargowork"]]), 1)
                removed = adapters.uninstall("workbuddy")["workbuddy"]
                self.assertTrue(removed["uninstalled"])
                remove_calls = [call for call in calls if call[1:6] == ["mcp", "remove", "-s", "user", "fargowork"]]
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
                if argv[1:4] == ["mcp", "get", "fargowork"]:
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

            plugin = config.plugin_dir
            plugin.parent.mkdir(parents=True, exist_ok=True)
            target = root / "owned-outside"
            target.mkdir()
            (target / ".fargowork-owner").write_text(self.cli.MARKER, encoding="utf-8")
            plugin.symlink_to(target, target_is_directory=True)
            with self.assertRaises(self.cli.FargoWorkError) as uninstall_error:
                self.cli._remove_owned_tree(config.home, plugin, label="FargoWork plugin")
            self.assertEqual(uninstall_error.exception.code, "unsafe_path")
            self.assertTrue(target.exists())


if __name__ == "__main__":
    unittest.main()
