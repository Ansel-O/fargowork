"""Employee CLI behavior against a local fake MCP resource, never live data."""
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
import uuid


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("employee_tools_cli_fixture", ROOT / "public/cli/fargowork_cli.py")
cli = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = cli
spec.loader.exec_module(cli)


def tool(name, properties=None, **extra):
    return {"name": name, "description": "Local public tool fixture",
            "inputSchema": {"type": "object", "properties": properties or {}}, **extra}


class EmployeeToolFixture(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, status, value, *, malformed=False):
        data = b"not-json fixture-secret" if malformed else json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Trace-ID", self.server.trace)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.server.calls.append(("GET", self.path))
        if self.path != "/auth/me" or self.headers.get("Authorization") != "Bearer fixture-access":
            self.reply(401, {"error": "invalid_token"})
            return
        self.reply(200, self.server.identity)

    def do_POST(self):
        if self.path != "/mcp":
            self.reply(404, {})
            return
        message = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        method = message["method"]
        params = message["params"]
        self.server.calls.append((method, params.get("name")))
        self.server.messages.append(message)
        assert self.headers["Authorization"] == "Bearer fixture-access"
        assert self.headers["MCP-Protocol-Version"] == cli.MCP_PROTOCOL_VERSION
        assert self.headers["Mcp-Method"] == method
        assert params["_meta"]["io.modelcontextprotocol/protocolVersion"] == cli.MCP_PROTOCOL_VERSION
        if method == "tools/call":
            assert self.headers["Mcp-Name"] == params["name"]
        if method == "server/discover":
            value = {"supportedVersions": [cli.MCP_PROTOCOL_VERSION], "capabilities": {"tools": {}},
                     "serverInfo": {"name": "isolated-employee-fixture", "version": "fixture"}}
        elif method == "tools/list":
            if self.server.repeating_cursor:
                value = {"tools": [], "nextCursor": "repeat"}
            else:
                value = {"tools": self.server.tools}
        else:
            name, arguments = params["name"], params["arguments"]
            if self.server.failure == "malformed":
                self.reply(200, {}, malformed=True)
                return
            if self.server.failure == "rpc":
                self.reply(200, {"jsonrpc": "2.0", "id": message["id"],
                                 "error": {"code": -32001, "message": "fixture-secret Bearer fixture-access", "data": {"token": "fixture-secret"}}})
                return
            if self.server.failure in (401, 503):
                self.reply(self.server.failure, {"error": "fixture-secret"})
                return
            if self.server.failure == "tool_error":
                value = {"content": [{"type": "text", "text": "fixture-secret"}], "isError": True}
            else:
                if name == "get_current_user":
                    body = dict(self.server.identity)
                elif name == "list_work_templates":
                    body = {"templates": [{"key": self.server.process_key}], "count": 1}
                elif name == "get_work_template_requirements":
                    body = {"key": arguments["template_key"], "required_user_inputs": ["reason"],
                            "review": {"confirmation_mode": "single_final"}}
                elif name == "prepare_process_draft":
                    ready = bool(arguments.get("user_inputs", {}).get("reason"))
                    body = {"draft_id": "fixture-draft", "process_key": arguments["process_key"],
                            "status": "ready_for_preview" if ready else "needs_input",
                            "preview": {"reason": arguments.get("user_inputs", {}).get("reason")} if ready else None}
                elif name == "submit_process_draft":
                    if arguments["draft_id"] == "foreign-draft":
                        self.reply(200, {"jsonrpc": "2.0", "id": message["id"],
                                         "error": {"code": -32001, "message": "Draft belongs to another fixture-secret subject"}})
                        return
                    if not self.server.role_allowed:
                        body = {"submitted": False, "status": "ready_for_preview",
                                "action_result": {"outcome": "rejected", "display_message": "测试角色不足，本次未提交。",
                                                  "automatic_retry_allowed": False}}
                    else:
                        body = {"submitted": True, "action_result": {"outcome": "succeeded", "code": "workflow_submit_succeeded",
                                "display_message": "测试申请已提交。", "automatic_retry_allowed": False}}
                else:
                    body = {"dynamic_tool": name, "echo": arguments}
                value = {"content": [{"type": "text", "text": json.dumps(body)}],
                         "structuredContent": body, "isError": False}
        self.reply(200, {"jsonrpc": "2.0", "id": message["id"], "result": value})


class EmployeeToolsCLITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fargowork-tools-test-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.environment = patch.dict(os.environ, {"USERPROFILE": str(self.home), "HOME": str(self.home),
            "APPDATA": str(self.home / "AppData/Roaming"), "LOCALAPPDATA": str(self.home / "AppData/Local"),
            "CODEX_HOME": str(self.home / ".codex"), "CLAUDE_CONFIG_DIR": str(self.home / ".claude")})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), EmployeeToolFixture)
        self.server.daemon_threads = True
        self.server.calls, self.server.messages = [], []
        self.server.trace = str(uuid.uuid4())
        self.server.identity = {"userid": "local-fixture-user", "corp_id": "local-fixture-corp", "name": "隔离用户"}
        self.server.process_key = "annual_leave"
        self.server.role_allowed = True
        self.server.failure = None
        self.server.repeating_cursor = False
        self.server.tools = [tool("get_current_user"), tool("list_work_templates"),
            tool("get_work_template_requirements", {"template_key": {"type": "string"}}),
            tool("prepare_process_draft", {"process_key": {"type": "string"}, "user_inputs": {"type": "object"}}),
            tool("submit_process_draft", {"draft_id": {"type": "string"}})]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        issuer = f"http://127.0.0.1:{self.server.server_port}"
        self.config = cli.Config(home=self.home / "FargoWork/employee", issuer=issuer, resource=issuer + "/mcp",
                                 resource_metadata_uri=issuer + "/.well-known/oauth-protected-resource",
                                 plugin_dir=self.home / "FargoWork/employee/plugin/fargowork-employee")
        self.session = cli.TokenSession(self.config, vault=cli.MemoryVault("fixture-refresh"),
                                        access_token="fixture-access", access_expires_at=time.time() + 600)

    def run_cli(self, arguments, *, stdin=""):
        out, err = io.StringIO(), io.StringIO()
        input_stream = stdin if hasattr(stdin, "read") else io.StringIO(stdin)
        def current_session(_config):
            self.session.diagnostics = cli._DIAGNOSTIC_CONTEXT.get()
            return self.session
        with patch.object(cli.Config, "load", return_value=self.config), patch.object(cli, "TokenSession", side_effect=current_session), \
             patch.object(cli, "ClientAdapters", side_effect=AssertionError("business CLI must not inspect or register any host")), \
             patch.object(sys, "stdin", input_stream), patch.object(sys, "stdout", out), patch.object(sys, "stderr", err):
            try:
                code = cli.main(arguments)
            except SystemExit as error:
                code = error.code
        self.assertEqual(err.getvalue(), "")
        self.assertEqual(len(out.getvalue().splitlines()), 1)
        serialized = out.getvalue()
        self.assertNotIn("fixture-secret", serialized)
        self.assertNotIn("fixture-access", serialized)
        return code, json.loads(serialized)

    def call(self, name, value=None, **kwargs):
        return self.run_cli(["tools", "call", name], stdin=json.dumps(value or {}, ensure_ascii=False), **kwargs)

    def body(self, result):
        return result["result"]["structuredContent"]

    def test_end_to_end_discovery_requirements_input_preview_and_confirmed_submit(self):
        code, listed = self.run_cli(["tools", "list"])
        self.assertEqual(code, 0)
        self.assertEqual(listed["event"], "tools_list")
        self.assertEqual(listed["identity"], self.server.identity)
        self.assertEqual(listed["server_trace_id"], self.server.trace)
        self.assertEqual({item["name"] for item in listed["tools"]}, {item["name"] for item in self.server.tools})
        self.assertEqual(self.call("get_current_user")[0], 0)
        self.assertEqual(self.body(self.call("list_work_templates")[1])["templates"][0]["key"], "annual_leave")
        self.assertEqual(self.body(self.call("get_work_template_requirements", {"template_key": "annual_leave"})[1])["review"]["confirmation_mode"], "single_final")
        missing = self.body(self.call("prepare_process_draft", {"process_key": "annual_leave", "user_inputs": {}})[1])
        self.assertEqual(missing["status"], "needs_input")
        preview = self.body(self.call("prepare_process_draft", {"process_key": "annual_leave", "user_inputs": {"reason": "个人事务"}})[1])
        self.assertEqual(preview["status"], "ready_for_preview")
        self.assertNotIn(("tools/call", "submit_process_draft"), self.server.calls)
        # The caller now simulates the user's explicit confirmation of this
        # exact preview. The CLI never invents or mechanically proves consent.
        code, submitted = self.call("submit_process_draft", {"draft_id": preview["draft_id"]})
        self.assertEqual(code, 0)
        self.assertTrue(self.body(submitted)["submitted"])
        self.assertEqual(self.body(submitted)["action_result"]["code"], "workflow_submit_succeeded")
        self.assertEqual(self.server.calls.count(("tools/call", "submit_process_draft")), 1)
        self.assertFalse((self.home / ".cursor/mcp.json").exists())
        self.assertFalse((self.home / ".codex/config.toml").exists())

    def test_new_workflow_and_public_tool_are_discovered_without_client_changes(self):
        self.server.process_key = "new_server_workflow"
        self.server.tools.append(tool("new_server_capability", {"query": {"type": "string"}}))
        code, result = self.call("new_server_capability", {"query": "动态能力"})
        self.assertEqual(code, 0)
        self.assertEqual(self.body(result)["dynamic_tool"], "new_server_capability")
        self.assertEqual(self.body(self.call("list_work_templates")[1])["templates"][0]["key"], "new_server_workflow")
        self.assertEqual(self.body(self.call("prepare_process_draft", {"process_key": "new_server_workflow", "user_inputs": {"reason": "明确输入"}})[1])["process_key"], "new_server_workflow")

    def test_utf8_stdin_ignores_windows_legacy_text_wrapper_encoding(self):
        reason = "年假申请：处理个人事务"
        arguments = {"process_key": "annual_leave", "user_inputs": {"reason": reason}}
        raw = json.dumps(arguments, ensure_ascii=False).encode("utf-8")
        for encoding in ("cp1252", "cp936"):
            for prefix in (b"", b"\xef\xbb\xbf"):
                with self.subTest(encoding=encoding, bom=bool(prefix)), \
                     io.TextIOWrapper(io.BytesIO(prefix + raw), encoding=encoding, errors="strict") as source:
                    code, result = self.run_cli(["tools", "call", "prepare_process_draft"], stdin=source)
                    self.assertEqual(code, 0)
                    self.assertEqual(self.body(result)["preview"]["reason"], reason)
                    self.assertEqual(self.server.messages[-1]["params"]["arguments"], arguments)

    def test_raw_stdin_invalid_utf8_or_byte_budget_fail_before_network(self):
        for raw in (b'{"reason":"\xff"}', b" " * (cli.MAX_TOOL_INPUT_BYTES + 1)):
            with self.subTest(invalid_utf8=raw.startswith(b"{")), \
                 io.TextIOWrapper(io.BytesIO(raw), encoding="cp1252") as source:
                code, result = self.run_cli(["tools", "call", "prepare_process_draft"], stdin=source)
                self.assertEqual(code, cli.EXIT_USAGE)
                self.assertEqual(result["error_code"], "tool_input_invalid")
        self.assertEqual(self.server.calls, [])

    def test_business_json_stdout_is_safe_for_legacy_windows_encoding(self):
        value = {"event": "tool_result", "result": {"reason": "年假申请：处理个人事务"}}
        with io.TextIOWrapper(io.BytesIO(), encoding="cp1252", errors="strict", newline="\n") as output:
            with patch.object(sys, "stdout", output):
                cli._emit_business_result(value)
            raw = output.buffer.getvalue()
        self.assertTrue(raw.isascii())
        self.assertEqual(len(raw.splitlines()), 1)
        self.assertEqual(json.loads(raw)["result"], value["result"])

    def test_role_rejection_and_other_subject_draft_never_retry(self):
        self.server.role_allowed = False
        code, result = self.call("submit_process_draft", {"draft_id": "fixture-draft"})
        self.assertEqual(code, 0, "a public business denial remains a structured Server result")
        self.assertFalse(self.body(result)["submitted"])
        self.assertEqual(self.body(result)["action_result"]["outcome"], "rejected")
        self.assertEqual(self.server.calls.count(("tools/call", "submit_process_draft")), 1)
        code, result = self.call("submit_process_draft", {"draft_id": "foreign-draft"})
        self.assertNotEqual(code, 0)
        self.assertEqual((result["error_kind"], result["error_code"]), ("server", "tool_server_error"))
        self.assertEqual(result["server_trace_id"], self.server.trace)
        self.assertEqual(self.server.calls.count(("tools/call", "submit_process_draft")), 2)

    def test_http_rpc_tool_and_malformed_failures_do_not_repeat_calls(self):
        for failure, kind, error_code in ((401, "auth", "auth_required"), (503, "server", "tool_http_error"),
                                         ("rpc", "server", "tool_server_error"), ("tool_error", "server", "tool_server_error"),
                                         ("malformed", "transport", "tool_response_invalid")):
            with self.subTest(failure=failure):
                self.server.failure = failure
                before = self.server.calls.count(("tools/call", "submit_process_draft"))
                code, result = self.call("submit_process_draft", {"draft_id": "fixture-draft"})
                self.assertNotEqual(code, 0)
                self.assertEqual((result["error_kind"], result["error_code"]), (kind, error_code))
                self.assertFalse(result["automatic_retry_allowed"])
                self.assertEqual(self.server.calls.count(("tools/call", "submit_process_draft")), before + 1)

    def test_unpublished_private_and_undeclared_input_never_reach_tool_call(self):
        self.server.tools.append(tool("private_tool", visibility="workflow_internal"))
        for name, inputs in (("private_tool", {}), ("not_published", {}), ("get_current_user", {"arbitrary": 1})):
            with self.subTest(name=name):
                code, result = self.call(name, inputs)
                self.assertEqual(code, cli.EXIT_USAGE)
                self.assertEqual(result["error_kind"], "input")
        self.assertFalse(any(method == "tools/call" for method, _ in self.server.calls))
        code, result = self.run_cli(["tools", "list"])
        self.assertEqual(code, 0)
        self.assertNotIn("private_tool", {item["name"] for item in result["tools"]})

    def test_strict_json_input_identity_and_transport_overrides_fail_before_network(self):
        bad = ('[]', '{"x":1,"x":2}', '{"x":NaN}', '{', '{"user_inputs":{"userid":"other"}}',
               '{"Authorization":"Bearer fixture-secret"}', '{"endpoint":"https://untrusted.invalid"}',
               '{"_meta":{"private":true}}', '"' + 'x' * cli.MAX_TOOL_INPUT_BYTES + '"')
        for text in bad:
            with self.subTest(case=text[:30]):
                code, result = self.run_cli(["tools", "call", "get_current_user"], stdin=text)
                self.assertEqual(code, cli.EXIT_USAGE)
                self.assertEqual(result["error_code"], "tool_input_invalid")
        self.assertEqual(self.server.calls, [])
        code, result = self.run_cli(["tools", "call", "get_current_user", "--bearer", "fixture-secret"])
        self.assertEqual(code, cli.EXIT_USAGE)
        self.assertEqual(result["error_kind"], "input")

    def test_input_file_literal_json_and_mutual_exclusion(self):
        source = self.home / "中文 输入.json"
        source.write_text('{"template_key":"annual_leave"}', encoding="utf-8")
        self.assertEqual(self.run_cli(["tools", "call", "get_work_template_requirements", "--input-file", str(source)])[0], 0)
        self.assertEqual(self.run_cli(["tools", "call", "get_current_user", "--input-json", "{}"]) [0], 0)
        before = len(self.server.calls)
        code, _ = self.run_cli(["tools", "call", "get_current_user", "--input-file", str(source), "--input-json", "{}"])
        self.assertEqual(code, cli.EXIT_USAGE)
        self.assertEqual(len(self.server.calls), before)

    def test_missing_auth_returns_official_login_without_browser_or_host_action(self):
        self.session.access_token = None
        self.session.vault = cli.MemoryVault()
        with patch.object(cli.webbrowser, "open", side_effect=AssertionError("business commands cannot open login")):
            code, result = self.run_cli(["tools", "list"])
        self.assertEqual(code, cli.EXIT_NEEDS_ACTION)
        self.assertEqual(result["next_action"], "login")
        self.assertEqual(result["login_args"], ["login", "--browser", "always"])
        self.assertEqual(self.server.calls, [])

    def test_catalog_pagination_is_bounded_and_diagnostics_have_no_input(self):
        self.server.repeating_cursor = True
        code, result = self.run_cli(["tools", "list"])
        self.assertNotEqual(code, 0)
        self.assertEqual(result["error_code"], "tools_discovery_invalid")
        self.assertEqual(self.server.calls.count(("tools/list", None)), 2)
        logs = self.config.home.parent / "diagnostics"
        text = "".join(path.read_text("utf-8") for path in logs.glob("diagnostic-*.jsonl"))
        self.assertNotIn("fixture-access", text)
        self.assertNotIn("local-fixture-user", text)
        self.assertNotIn("user_inputs", text)
        self.assertTrue(all(json.loads(line)["command"] == "tools" for line in text.splitlines()))

    def test_cli_mode_default_status_and_doctor_do_not_need_mcp_registration(self):
        binary = self.config.home / "bin" / ("fargowork.exe" if cli.platform.system() == "Windows" else "fargowork")
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b"isolated fixture binary; never executed")
        skill = cli._canonical_skill_path(self.config) / "SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text("isolated skill", encoding="utf-8")
        self.assertEqual(cli._build_parser().parse_args(["status"]).target, "cli")
        with patch.object(cli, "_detect_command", side_effect=AssertionError("no host detection")):
            adapters = cli.ClientAdapters(self.config)
            clients = adapters.register("cli")
            self.assertFalse(cli._registration_failed(clients, "cli"))
            result = cli._status_payload(self.config, clients=clients, target="cli", connected=True, identity=self.server.identity)
            self.assertFalse(result["needs_user_action"])
            self.assertEqual(result["trusted"], "not_required")
            self.assertFalse(result["mcp_registration_required"])
            self.assertNotIn("manual_mcp_registration", result)
            self.assertEqual(result["tool_capability"], "not_checked")
            with patch.object(self.config, "secure_vault", return_value=cli.MemoryVault("fixture-refresh")):
                doctor = cli._doctor(self.config, target="cli")
            self.assertEqual(doctor["status"], "ready")
        self.assertFalse((self.config.home / "adapters").exists())

    def test_browser_failure_is_immediate_for_auto_and_always(self):
        for mode in ("auto", "always"):
            for failure in (False, RuntimeError("fixture-secret")):
                with self.subTest(mode=mode, failure=type(failure).__name__):
                    waiter = unittest.mock.Mock()
                    with patch.object(cli, "_CallbackWaiter", return_value=waiter), \
                         patch.object(cli.webbrowser, "open", side_effect=failure if isinstance(failure, Exception) else None,
                                      return_value=failure), patch.object(cli, "_emit_event") as output:
                        with self.assertRaises(cli.FargoWorkError) as caught:
                            self.session.login(browser=mode, timeout=300)
                        self.assertEqual(caught.exception.code, "browser_unavailable")
                        waiter.wait.assert_not_called()
                        waiter.close.assert_called_once()
                        output.assert_not_called()


if __name__ == "__main__":
    unittest.main()
