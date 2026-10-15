"""Attachment CLI coordination at a loopback boundary, never a real company API."""
from copy import deepcopy
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
from typing import Any, Dict
import unittest
from unittest.mock import Mock, patch
import uuid

import anyio
from mcp import Client
from mcp.server import MCPServer


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("attachment_cli_fixture_runtime", ROOT / "public/cli/fargowork_cli.py")
cli = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = cli
spec.loader.exec_module(cli)
attachments = cli.employee_attachments


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def respond(self, status, value):
        data = json.dumps(value, ensure_ascii=False).encode("utf8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.server.requests.append(("GET", self.path))
        if self.headers.get("Authorization") != "Bearer fixture-attachment-token":
            self.respond(401, {})
        elif self.path == "/api/v1/me":
            self.respond(200, self.server.identity)
        else:
            self.respond(404, {})

    def do_POST(self):
        self.server.requests.append(("POST", self.path))
        if self.headers.get("Authorization") != "Bearer fixture-attachment-token":
            self.respond(401, {})
            return
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        if self.path == "/api/v1/attachments":
            parsed = BytesParser(policy=default).parsebytes(b"Content-Type: " + self.headers["Content-Type"].encode() + b"\r\n\r\n" + raw)
            fields = {part.get_param("name", header="content-disposition"): part for part in parsed.iter_parts()}
            part = fields["file"]
            file_id = str(uuid.uuid4())
            value = {"id": file_id, "name": part.get_filename(), "size": len(part.get_payload(decode=True)),
                     "type": "application/pdf", "downloadUrl": self.server.origin + "/api/v1/files/" + file_id}
            self.server.uploads.append((fields["batch_id"].get_content().strip(), value))
            if self.server.drop_upload:
                self.close_connection = True
                return
            if self.server.bad_url:
                value["downloadUrl"] = "https://untrusted.example/file"
            self.respond(200, value)
        elif self.path.endswith("/selection"):
            value = json.loads(raw)
            self.server.selection = value["attachment_ids"]
            self.respond(200, {"batch_id": self.path.split("/")[4], "attachment_ids": self.server.selection, "status": "saved"})
        elif self.path.endswith("/submission-notice"):
            value = json.loads(raw)
            self.server.notices.append(value)
            if self.server.drop_notice:
                self.server.drop_notice = False
                self.close_connection = True
                return
            self.respond(202, {"state": "confirmed", "flow_binding_confirmed": True,
                               "replayed": len(self.server.notices) > 1})
        else:
            self.respond(404, {})


class EmployeeAttachmentCLITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fargowork-attachment-unit-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.origin = f"http://127.0.0.1:{self.server.server_port}"
        self.server.identity = {"userid": "fixture-user", "corp_id": "fixture-company", "name": "测试员工",
                                "client_id": attachments.NATIVE_CLIENT, "scope": attachments.SCOPE}
        self.server.requests, self.server.uploads, self.server.notices = [], [], []
        self.server.drop_upload = self.server.drop_notice = self.server.bad_url = False
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.config = cli.Config(home=self.root / "employee", issuer=self.server.origin,
            resource=self.server.origin + "/mcp", resource_metadata_uri=self.server.origin + "/.well-known/oauth-protected-resource",
            attachments_url=self.server.origin)
        self.config.home.mkdir()
        identity = self.server.identity
        class Session:
            def __init__(self, config):
                self.config = config
            def access(self):
                return "fixture-attachment-token" if self.config.scope == attachments.SCOPE else "fixture-mcp-token"
            def me(self):
                return {key: identity[key] for key in ("userid", "corp_id", "name")}
        self.session_class = Session
        with patch.object(cli, "TokenSession", Session):
            self.client = attachments.AttachmentClient(cli, self.config)
        self.file = self.root / "个人资料.pdf"
        self.file.write_bytes(b"%PDF-1.4 synthetic fixture only")

    def prepare(self, batch, ids):
        args = {"process_key": attachments.PROCESS, "user_inputs": {"attachment_batch_id": batch, "attachment_ids": ids}}
        context = self.client.before_tool("prepare_process_draft", args)
        draft = str(uuid.uuid4())
        value = {"draft_id": draft, "ready_to_submit": True,
                 "attachment_selection": {"batch_id": batch, "attachment_ids": ids, "flow_type": "external-payment"}}
        self.client.after_tool("prepare_process_draft", args, {"structuredContent": value}, context)
        return draft

    def cli_tool(self, name, arguments, response=None):
        """Exercise the real CLI coordinator; only the upstream business is fake."""
        tools = Mock()
        tools.identity = {key: self.server.identity[key] for key in ("userid", "corp_id", "name")}
        tools.trace.return_value = {}
        tools.call.return_value = deepcopy(response)
        out, err = io.StringIO(), io.StringIO()
        with patch.object(cli.Config, "load", return_value=self.config), patch.object(cli, "TokenSession", self.session_class), \
             patch.object(cli, "EmployeeToolsClient", return_value=tools), patch.object(sys, "stdin", io.StringIO(json.dumps(arguments))), \
             patch.object(sys, "stdout", out), patch.object(sys, "stderr", err):
            code = cli.main(["tools", "call", name, "--output", "jsonl"])
        self.assertEqual(err.getvalue(), "")
        self.assertEqual(len(out.getvalue().splitlines()), 1)
        return code, json.loads(out.getvalue()), tools.call

    def test_actual_sdk_dict_result_envelopes_prepare_submit_and_notify_once(self):
        for text_only in (False, True):
            with self.subTest(text_only=text_only):
                batch = self.client.create(attachments.PROCESS)["batch_id"]
                file_id = self.client.upload(batch, self.file)["file"]["id"]
                draft = str(uuid.uuid4())
                arguments = {"process_key": attachments.PROCESS,
                             "user_inputs": {"attachment_batch_id": batch, "attachment_ids": [file_id]}}
                sdk = MCPServer("attachment-envelope-fixture")
                writes = []

                @sdk.tool()
                def prepare_process_draft(process_key: str, user_inputs: dict) -> Dict[str, Any]:
                    self.assertEqual(process_key, attachments.PROCESS)
                    self.assertEqual(user_inputs["attachment_ids"], [file_id])
                    return {"draft_id": draft, "ready_to_submit": True,
                            "attachment_selection": {"batch_id": batch, "attachment_ids": [file_id],
                                                     "flow_type": "external-payment"}}

                @sdk.tool()
                def submit_process_draft(draft_id: str) -> Dict[str, Any]:
                    self.assertEqual(draft_id, draft)
                    writes.append(draft_id)
                    return {"submitted": True, "process_instance_id": "fixture-sdk-instance"}

                def wire(response):
                    # Constructed by the real SDK's annotated dict tool, not a
                    # hand-written approximation of its business envelope.
                    self.assertEqual(set(response.structured_content), {"result"})
                    result = {"content": [item.model_dump(by_alias=True, exclude_none=True) for item in response.content],
                              "isError": response.is_error}
                    if not text_only:
                        result["structuredContent"] = response.structured_content
                    return result

                async def exercise():
                    async with Client(sdk, mode="2026-07-28") as peer:
                        context = self.client.before_tool("prepare_process_draft", arguments)
                        prepared = wire(await peer.call_tool("prepare_process_draft", arguments))
                        original = deepcopy(prepared)
                        self.client.after_tool("prepare_process_draft", arguments, prepared, context)
                        self.assertEqual(prepared, original)
                        with self.client.state(batch) as state:
                            self.assertEqual(state["active_draft_id"], draft)
                            self.assertEqual(state["drafts"][draft]["attachment_ids"], [file_id])
                        context = self.client.before_tool("submit_process_draft", {"draft_id": draft})
                        submitted = wire(await peer.call_tool("submit_process_draft", {"draft_id": draft}))
                        original = deepcopy(submitted)
                        binding = self.client.after_tool("submit_process_draft", {"draft_id": draft}, submitted, context)
                        self.assertEqual(submitted, original)
                        self.assertTrue(binding["flow_binding_confirmed"])

                before = len(self.server.notices)
                anyio.run(exercise)
                self.assertEqual(writes, [draft])
                self.assertEqual(len(self.server.notices), before + 1)
                self.assertEqual(self.server.notices[-1]["attachment_ids"], [file_id])
                with self.assertRaises(attachments.AttachmentError):
                    self.client.before_tool("submit_process_draft", {"draft_id": draft})

    def test_cli_preserves_original_sdk_envelope_while_coordinating_notification(self):
        batch = self.client.create(attachments.PROCESS)["batch_id"]
        file_id = self.client.upload(batch, self.file)["file"]["id"]
        draft = str(uuid.uuid4())
        body = {"draft_id": draft, "ready_to_submit": True,
                "attachment_selection": {"batch_id": batch, "attachment_ids": [file_id], "flow_type": "external-payment"}}
        envelope = {"structuredContent": {"result": body},
                    "content": [{"type": "text", "text": json.dumps({"result": body})}], "isError": False}
        code, output, call = self.cli_tool("prepare_process_draft", {
            "process_key": attachments.PROCESS, "user_inputs": {"attachment_batch_id": batch, "attachment_ids": [file_id]}}, envelope)
        self.assertEqual(code, 0)
        self.assertEqual(output["result"], envelope)
        call.assert_called_once()
        submitted = {"submitted": True, "process_instance_id": "fixture-cli-instance"}
        envelope = {"structuredContent": {"result": submitted}, "content": [], "isError": False}
        code, output, call = self.cli_tool("submit_process_draft", {"draft_id": draft}, envelope)
        self.assertEqual(code, 0)
        self.assertEqual(output["result"], envelope)
        self.assertTrue(output["attachment_binding"]["flow_binding_confirmed"])
        call.assert_called_once()
        self.assertEqual(len(self.server.notices), 1)

    def test_malformed_mcp_envelope_invalidates_old_preview_and_never_sends_submit(self):
        batch = self.client.create(attachments.PROCESS)["batch_id"]
        file_id = self.client.upload(batch, self.file)["file"]["id"]
        old_draft = self.prepare(batch, [file_id])
        arguments = {"process_key": attachments.PROCESS, "user_inputs": {"attachment_batch_id": batch, "attachment_ids": [file_id]}}
        for response in (
            {"structuredContent": {"result": None}}, {"structuredContent": {"result": []}},
            {"structuredContent": {"result": {"result": {"draft_id": old_draft}}}},
            {"structuredContent": {"result": {}, "ready_to_submit": True}},
            {"structuredContent": [], "content": [{"type": "text", "text": json.dumps({"draft_id": old_draft})}]},
            {"content": [{"type": "text", "text": "{not valid JSON"}]},
            {"content": [{"type": "text", "text": json.dumps({"result": "not a business object"})}]},
            {"structuredContent": {"result": {"ready_to_submit": True}}},
            {"structuredContent": {"result": {"draft_id": "not-a-valid-draft", "ready_to_submit": True}}},
            {"structuredContent": {}, "isError": "true"},
        ):
            with self.subTest(response=response):
                context = self.client.before_tool("prepare_process_draft", arguments)
                with self.assertRaises(attachments.AttachmentError) as raised:
                    self.client.after_tool("prepare_process_draft", arguments, response, context)
                self.assertEqual(raised.exception.code, "attachment_response_invalid")
                with self.client.state(batch) as state:
                    self.assertIsNone(state["active_draft_id"])
                code, output, submit = self.cli_tool("submit_process_draft", {"draft_id": old_draft})
                self.assertNotEqual(code, 0)
                submit.assert_not_called()
                self.assertEqual(output["error_code"], "attachment_state_invalid")
        self.assertEqual(self.server.notices, [])

    def test_unverified_prepare_draft_cannot_bypass_attachment_checks(self):
        batch = self.client.create(attachments.PROCESS)["batch_id"]
        file_id = self.client.upload(batch, self.file)["file"]["id"]
        arguments = {"process_key": attachments.PROCESS, "user_inputs": {"attachment_batch_id": batch, "attachment_ids": [file_id]}}
        for change in ("missing_selection", "wrong_batch", "wrong_ids", "invalid_flow", "non_boolean_ready", "contradictory_ready"):
            with self.subTest(change=change):
                draft = str(uuid.uuid4())
                value = {"draft_id": draft, "ready_to_submit": True,
                         "attachment_selection": {"batch_id": batch, "attachment_ids": [file_id], "flow_type": "external-payment"}}
                if change == "missing_selection":
                    value.pop("attachment_selection")
                elif change == "wrong_batch":
                    value["attachment_selection"]["batch_id"] = str(uuid.uuid4())
                elif change == "wrong_ids":
                    value["attachment_selection"]["attachment_ids"] = []
                elif change == "invalid_flow":
                    value["attachment_selection"]["flow_type"] = "private\nvalue"
                elif change == "non_boolean_ready":
                    value["ready_to_submit"] = "true"
                else:
                    value["errors"] = [{"code": "synthetic-denial"}]
                context = self.client.before_tool("prepare_process_draft", arguments)
                with self.assertRaises(attachments.AttachmentError) as raised:
                    self.client.after_tool("prepare_process_draft", arguments, {"structuredContent": {"result": value}}, context)
                self.assertEqual(raised.exception.code, "attachment_response_invalid")
                code, _, submit = self.cli_tool("submit_process_draft", {"draft_id": draft})
                self.assertNotEqual(code, 0)
                submit.assert_not_called()
        self.assertEqual(self.server.notices, [])

    def test_actual_not_ready_business_result_is_preserved_without_authorizing_submit(self):
        batch = self.client.create(attachments.PROCESS)["batch_id"]
        file_id = self.client.upload(batch, self.file)["file"]["id"]
        draft = str(uuid.uuid4())
        body = {"draft_id": draft, "ready_to_submit": False,
                "needs_input": [{"field": "description", "code": "required"}]}
        envelope = {"structuredContent": {"result": body}, "content": [], "isError": False}
        code, output, _ = self.cli_tool("prepare_process_draft", {"process_key": attachments.PROCESS,
            "user_inputs": {"attachment_batch_id": batch, "attachment_ids": [file_id]}}, envelope)
        self.assertEqual(code, 0)
        self.assertEqual(output["result"], envelope)
        self.assertNotIn("attachment_binding", output)
        code, _, submit = self.cli_tool("submit_process_draft", {"draft_id": draft})
        self.assertNotEqual(code, 0)
        submit.assert_not_called()
        self.assertEqual(self.server.notices, [])

    def test_is_error_never_turns_a_ready_payload_into_a_valid_preview(self):
        batch = self.client.create(attachments.PROCESS)["batch_id"]
        file_id = self.client.upload(batch, self.file)["file"]["id"]
        old = self.prepare(batch, [file_id])
        args = {"process_key": attachments.PROCESS, "user_inputs": {"attachment_batch_id": batch, "attachment_ids": [file_id]}}
        context = self.client.before_tool("prepare_process_draft", args)
        response = {"structuredContent": {"result": {"draft_id": old, "ready_to_submit": True}}, "isError": True}
        with self.assertRaises(attachments.AttachmentError):
            self.client.after_tool("prepare_process_draft", args, response, context)
        code, _, submit = self.cli_tool("submit_process_draft", {"draft_id": old})
        self.assertNotEqual(code, 0)
        submit.assert_not_called()

    def test_malformed_submit_envelope_retains_unknown_and_never_notifies_or_resubmits(self):
        for response in ({"structuredContent": {"result": []}},
                         {"structuredContent": {"result": {"submitted": True}}},
                         {"structuredContent": {"result": {"submitted": True, "process_instance_id": "fixture-instance"}}, "isError": True}):
            with self.subTest(response=response):
                batch = self.client.create(attachments.PROCESS)["batch_id"]
                file_id = self.client.upload(batch, self.file)["file"]["id"]
                draft = self.prepare(batch, [file_id])
                context = self.client.before_tool("submit_process_draft", {"draft_id": draft})
                with self.assertRaises(attachments.AttachmentError):
                    self.client.after_tool("submit_process_draft", {}, response, context)
                self.assertEqual(self.client.status(batch)["submission_state"], "unknown")
                code, _, submit = self.cli_tool("submit_process_draft", {"draft_id": draft})
                self.assertNotEqual(code, 0)
                submit.assert_not_called()
        self.assertEqual(self.server.notices, [])

    def test_notice_retains_only_fixed_safe_support_fields(self):
        batch = self.client.create(attachments.PROCESS)["batch_id"]
        file_id = self.client.upload(batch, self.file)["file"]["id"]
        draft = self.prepare(batch, [file_id])
        context = self.client.before_tool("submit_process_draft", {"draft_id": draft})
        attempt = str(uuid.uuid4())
        pending = {"state": "pending_confirmation", "flow_binding_confirmed": False,
                   "pending_reason": "readback_identity_mismatch", "attempt_id": attempt, "raw": "secret upstream body"}
        with patch.object(self.client, "_request", return_value=(202, pending)):
            binding = self.client.after_tool("submit_process_draft", {}, {"structuredContent": {"result": {
                "submitted": True, "process_instance_id": "fixture-instance"}}}, context)
        self.assertEqual(binding["pending_reason"], "readback_identity_mismatch")
        self.assertEqual(binding["attempt_id"], attempt)
        with self.client.state(batch) as state:
            self.assertEqual(state["submission"]["last_notice"], {"pending_reason": "readback_identity_mismatch", "attempt_id": attempt})
            self.assertNotIn("secret upstream body", json.dumps(state))
        for reason in ("SECRET_EMPLOYEE_OR_TOKEN", {"raw": "secret"}):
            with self.subTest(reason=reason), patch.object(self.client, "_request", return_value=(202, {
                **pending, "pending_reason": reason, "attempt_id": "not-a-safe-support-id"})):
                binding = self.client.notify(batch, verified=True)
                self.assertNotIn("pending_reason", binding)
                self.assertNotIn("attempt_id", binding)

    def test_same_batch_remove_add_preview_submit_and_same_key_notice(self):
        batch = self.client.create(attachments.PROCESS)["batch_id"]
        first = self.client.upload(batch, self.file)["file"]["id"]
        second = self.client.upload(batch, self.file)["file"]["id"]
        self.client.select(batch, [second])
        third = self.client.upload(batch, self.file)["file"]["id"]
        draft = self.prepare(batch, [second, third])
        self.assertEqual({item[0] for item in self.server.uploads}, {batch})
        self.assertNotIn(first, self.server.selection)
        context = self.client.before_tool("submit_process_draft", {"draft_id": draft})
        binding = self.client.after_tool("submit_process_draft", {}, {"structuredContent": {
            "submitted": True, "process_instance_id": "fixture-instance"}}, context)
        self.assertTrue(binding["flow_binding_confirmed"])
        replay = self.client.notify(batch)
        self.assertTrue(replay["replayed"])
        self.assertEqual(self.server.notices[0], self.server.notices[1])
        self.assertEqual(self.server.notices[0]["attachment_ids"], [second, third])
        with self.assertRaises(attachments.AttachmentError):
            self.client.before_tool("submit_process_draft", {"draft_id": draft})

    def test_unknown_upload_does_not_retry_same_file(self):
        batch = self.client.create(attachments.PROCESS)["batch_id"]
        self.server.drop_upload = True
        with self.assertRaises(attachments.AttachmentError):
            self.client.upload(batch, self.file)
        with self.assertRaises(attachments.AttachmentError) as raised:
            self.client.upload(batch, self.file)
        self.assertEqual(raised.exception.code, "attachment_upload_unknown")
        self.assertEqual(len(self.server.uploads), 1)
        self.assertTrue(self.client.status(batch)["upload_result_unknown"])

    def test_lost_notice_keeps_business_success_and_retry_exact_snapshot(self):
        batch = self.client.create(attachments.PROCESS)["batch_id"]
        file_id = self.client.upload(batch, self.file)["file"]["id"]
        draft = self.prepare(batch, [file_id])
        context = self.client.before_tool("submit_process_draft", {"draft_id": draft})
        self.server.drop_notice = True
        value = self.client.after_tool("submit_process_draft", {}, {"structuredContent": {
            "submitted": True, "process_instance_id": "fixture-instance"}}, context)
        self.assertTrue(value["business_submitted"])
        self.assertFalse(value["flow_binding_confirmed"])
        self.assertEqual(self.client.status(batch)["submission_state"], "submitted")
        self.assertTrue(self.client.notify(batch)["flow_binding_confirmed"])
        self.assertEqual(self.server.notices[0], self.server.notices[1])
        self.client.notify(batch)
        with self.assertRaises(attachments.AttachmentError):
            self.client.notify(batch)
        self.assertEqual(len(self.server.notices), 3)

    def test_unknown_business_never_sends_attachment_notice(self):
        batch = self.client.create(attachments.PROCESS)["batch_id"]
        file_id = self.client.upload(batch, self.file)["file"]["id"]
        draft = self.prepare(batch, [file_id])
        context = self.client.before_tool("submit_process_draft", {"draft_id": draft})
        self.client.tool_failed("submit_process_draft", context)
        with self.assertRaises(attachments.AttachmentError):
            self.client.notify(batch)
        self.assertEqual(self.server.notices, [])
        self.assertEqual(self.client.status(batch)["submission_state"], "unknown")

    def test_known_success_survives_local_result_save_failure(self):
        batch = self.client.create(attachments.PROCESS)["batch_id"]
        file_id = self.client.upload(batch, self.file)["file"]["id"]
        draft = self.prepare(batch, [file_id])
        context = self.client.before_tool("submit_process_draft", {"draft_id": draft})
        with patch.object(cli, "_atomic_write", side_effect=OSError("synthetic disk full")):
            binding = self.client.after_tool("submit_process_draft", {}, {"structuredContent": {
                "submitted": True, "process_instance_id": "fixture-instance"}}, context)
        self.assertTrue(binding["business_submitted"])
        self.assertFalse(binding["local_result_saved"])
        self.assertEqual(binding["state"], "pending_local_recovery")
        self.assertEqual(self.server.notices, [])
        self.assertEqual(self.client.status(batch)["submission_state"], "sending")
        with self.assertRaises(attachments.AttachmentError):
            self.client.before_tool("submit_process_draft", {"draft_id": draft})

    def test_known_success_survives_notice_attempt_save_failure(self):
        batch = self.client.create(attachments.PROCESS)["batch_id"]
        file_id = self.client.upload(batch, self.file)["file"]["id"]
        draft = self.prepare(batch, [file_id])
        context = self.client.before_tool("submit_process_draft", {"draft_id": draft})
        write = cli._atomic_write

        def fail_notice_attempt(path, data):
            submission = json.loads(data).get("submission") or {}
            if "notice_attempts" in submission:
                raise OSError("synthetic disk full")
            return write(path, data)

        with patch.object(cli, "_atomic_write", fail_notice_attempt):
            binding = self.client.after_tool("submit_process_draft", {}, {"structuredContent": {
                "submitted": True, "process_instance_id": "fixture-instance"}}, context)
        self.assertTrue(binding["business_submitted"])
        self.assertTrue(binding["local_result_saved"])
        self.assertEqual(binding["state"], "pending_confirmation")
        self.assertEqual(self.client.status(batch)["submission_state"], "submitted")
        self.assertEqual(self.server.notices, [])
        self.assertTrue(self.client.notify(batch)["flow_binding_confirmed"])

    def test_late_pending_notice_cannot_downgrade_confirmed_binding(self):
        batch = self.client.create(attachments.PROCESS)["batch_id"]
        file_id = self.client.upload(batch, self.file)["file"]["id"]
        draft = self.prepare(batch, [file_id])
        context = self.client.before_tool("submit_process_draft", {"draft_id": draft})
        self.client.after_tool("submit_process_draft", {}, {"structuredContent": {
            "submitted": True, "process_instance_id": "fixture-instance"}}, context)
        with patch.object(self.client, "_request", return_value=(202, {
                "state": "pending_confirmation", "flow_binding_confirmed": False})):
            binding = self.client.notify(batch, verified=True)
        self.assertTrue(binding["flow_binding_confirmed"])
        self.assertEqual(self.client.status(batch)["attachment_binding"], "confirmed")

    def test_changed_selection_invalidates_previous_draft(self):
        batch = self.client.create(attachments.PROCESS)["batch_id"]
        file_id = self.client.upload(batch, self.file)["file"]["id"]
        draft = self.prepare(batch, [file_id])
        self.client.select(batch, [])
        with self.assertRaises(attachments.AttachmentError):
            self.client.before_tool("submit_process_draft", {"draft_id": draft})

    def test_concurrent_submit_reserves_only_once_and_preserves_notice_key(self):
        batch = self.client.create(attachments.PROCESS)["batch_id"]
        file_id = self.client.upload(batch, self.file)["file"]["id"]
        draft = self.prepare(batch, [file_id])
        discover = self.client._find_draft
        barrier = threading.Barrier(2)
        contexts, failures = [], []

        def simultaneous_discovery(draft_id):
            snapshot = discover(draft_id)
            barrier.wait(timeout=5)
            return snapshot

        def submit():
            try:
                contexts.append(self.client.before_tool("submit_process_draft", {"draft_id": draft}))
            except attachments.AttachmentError as error:
                failures.append(error.code)

        with patch.object(self.client, "_find_draft", simultaneous_discovery):
            workers = [threading.Thread(target=submit) for _ in range(2)]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(timeout=10)
            self.assertFalse(any(worker.is_alive() for worker in workers))
        self.assertEqual(len(contexts), 1)
        self.assertEqual(failures, ["attachment_state_invalid"])
        with self.client.state(batch) as state:
            key = state["submission"]["idempotency_key"]
            self.assertEqual(state["submission"]["state"], "sending")
        self.client.after_tool("submit_process_draft", {}, {"structuredContent": {
            "submitted": True, "process_instance_id": "fixture-instance"}}, contexts[0])
        self.assertEqual(len(self.server.notices), 1)
        self.assertEqual(self.server.notices[0]["idempotency_key"], key)

    def test_stale_discovery_cannot_overwrite_submission_or_selection(self):
        batch = self.client.create(attachments.PROCESS)["batch_id"]
        file_id = self.client.upload(batch, self.file)["file"]["id"]
        draft = self.prepare(batch, [file_id])
        snapshot = self.client._find_draft(draft)
        cases = [
            {"state": "sending", "idempotency_key": "fixture-existing-key"},
            {"state": "submitted", "idempotency_key": "fixture-existing-key"},
            {"state": "unknown", "idempotency_key": "fixture-existing-key"},
            None,
        ]
        for submission in cases:
            with self.subTest(state=(submission or {}).get("state", "selection_changed")):
                with self.client.state(batch) as state:
                    state["submission"] = submission
                    state["selected_ids"] = [] if submission is None else [file_id]
                with patch.object(self.client, "_find_draft", return_value=snapshot):
                    with self.assertRaises(attachments.AttachmentError):
                        self.client.before_tool("submit_process_draft", {"draft_id": draft})
                with self.client.state(batch) as state:
                    self.assertEqual(state["submission"], submission)

    def test_other_account_cannot_reuse_batch_or_upload(self):
        batch = self.client.create(attachments.PROCESS)["batch_id"]
        self.server.identity = {**self.server.identity, "corp_id": "other-company"}
        with self.assertRaises(attachments.AttachmentError) as raised:
            self.client.upload(batch, self.file)
        self.assertEqual(raised.exception.code, "attachment_identity_mismatch")
        self.assertEqual(self.server.uploads, [])

    def test_upload_response_cannot_redirect_stable_file_address(self):
        batch = self.client.create(attachments.PROCESS)["batch_id"]
        self.server.bad_url = True
        with self.assertRaises(attachments.AttachmentError) as raised:
            self.client.upload(batch, self.file)
        self.assertEqual(raised.exception.code, "attachment_response_invalid")
        self.assertEqual(self.client.status(batch)["selected_ids"], [])

    def test_upload_address_is_the_exact_server_link_without_tokens_or_page_cache_parameters(self):
        file_id = str(uuid.uuid4())
        stable = self.server.origin + "/api/v1/files/" + file_id
        returned = {"id": file_id, "name": "fixture.pdf", "size": 1,
                    "type": "application/pdf", "downloadUrl": stable}
        self.assertEqual(self.client._validate_file(returned)["downloadUrl"], stable)
        for suffix in ("?token=synthetic-marker", "?v=page-script-cache", "#fragment", "?view=inline"):
            with self.subTest(suffix=suffix):
                with self.assertRaises(attachments.AttachmentError) as raised:
                    self.client._validate_file({**returned, "downloadUrl": stable + suffix})
                self.assertEqual(raised.exception.code, "attachment_response_invalid")

    def test_cli_stdout_one_result_no_tokens_or_diagnostic_payload(self):
        out, err = io.StringIO(), io.StringIO()
        with patch.object(cli.Config, "load", return_value=self.config), patch.object(cli, "TokenSession", self.session_class), \
             patch.object(sys, "stdout", out), patch.object(sys, "stderr", err):
            result = cli.main(["attachments", "create", "--output", "jsonl"])
        self.assertEqual(result, 0)
        self.assertEqual(err.getvalue(), "")
        self.assertEqual(len(out.getvalue().splitlines()), 1)
        self.assertEqual(json.loads(out.getvalue())["event"], "attachment_result")
        for path in (self.root / "diagnostics").glob("*.jsonl"):
            data = path.read_text("utf8")
            self.assertNotIn("fixture-attachment-token", data)
            self.assertNotIn("fixture-company", data)
            self.assertNotIn("个人资料", data)

    def test_corrupt_batch_state_is_one_controlled_json_error(self):
        batch = self.client.create(attachments.PROCESS)["batch_id"]
        state_path = self.client._account_root() / (batch + ".json")
        valid = json.loads(state_path.read_bytes())
        for corrupted in ([], {"schema_version": 1, "batch_id": batch},
                          {**valid, "selected_ids": [str(uuid.uuid4())]}):
            with self.subTest(shape=type(corrupted).__name__):
                state_path.write_text(json.dumps(corrupted), encoding="utf8")
                out, err = io.StringIO(), io.StringIO()
                with patch.object(cli.Config, "load", return_value=self.config), patch.object(cli, "TokenSession", self.session_class), \
                     patch.object(sys, "stdout", out), patch.object(sys, "stderr", err):
                    result = cli.main(["attachments", "status", "--batch", batch])
                self.assertEqual(result, cli.EXIT_USAGE)
                self.assertEqual(err.getvalue(), "")
                self.assertEqual(len(out.getvalue().splitlines()), 1)
                self.assertEqual(json.loads(out.getvalue())["error_code"], "attachment_state_invalid")

    def test_logout_clears_both_purpose_specific_sessions(self):
        self.client.create(attachments.PROCESS)
        revoked = []
        parent = self.session_class
        class LogoutSession(parent):
            def logout(self):
                revoked.append(self.config.scope)
                return {"local_credentials_cleared": True, "remote_revocation": "confirmed"}
        out = io.StringIO()
        with patch.object(cli.Config, "load", return_value=self.config), patch.object(cli, "TokenSession", LogoutSession), \
             patch.object(sys, "stdout", out):
            result = cli.main(["logout", "--output", "jsonl"])
        self.assertEqual(result, 0)
        self.assertEqual(revoked, [attachments.SCOPE, cli.MCP_SCOPE])
        self.assertEqual(json.loads(out.getvalue())["attachment_logout"]["remote_revocation"], "confirmed")

    def test_native_and_business_vault_slots_are_distinct(self):
        native = self.client.native.config
        self.assertEqual(native.redirect_uri, "http://127.0.0.1:37681/oauth/callback")
        self.assertNotEqual(native.resource, self.config.resource)
        self.assertNotEqual(native.scope, self.config.scope)
        self.assertNotEqual(native.secure_vault().vault_filename, self.config.secure_vault().vault_filename)

    def test_optional_attachment_issuer_uses_separate_auth_and_preserves_inherited_batch_namespace(self):
        self.client.verify()
        legacy = hashlib.sha256(json.dumps({"issuer": self.config.issuer, "resource": self.server.origin,
            "environment": self.config.environment, "corp_id": self.server.identity["corp_id"],
            "userid": self.server.identity["userid"]}, sort_keys=True).encode()).hexdigest()
        inherited_root = self.client._account_root()
        self.assertEqual(inherited_root.name, legacy)
        self.assertEqual(self.client.native.config.issuer, self.config.issuer)
        self.config.attachments_issuer = self.config.issuer
        with patch.object(cli, "TokenSession", self.session_class):
            same = attachments.AttachmentClient(cli, self.config)
        self.assertEqual(same._account_root(), inherited_root)
        self.config.attachments_issuer = "https://separate-auth.example.test"
        with patch.object(cli, "TokenSession", self.session_class):
            separate = attachments.AttachmentClient(cli, self.config)
        self.assertEqual(separate.native.config.issuer, "https://separate-auth.example.test")
        self.assertEqual(separate.native.config.resource, self.server.origin)
        self.assertEqual(separate.native.config.scope, attachments.SCOPE)
        self.assertEqual(separate.native.config.resource_metadata_uri, self.server.origin + "/.well-known/oauth-protected-resource")
        self.assertEqual(self.config.issuer, self.server.origin)
        self.assertNotEqual(separate._account_root(), inherited_root)
        self.assertNotEqual(separate.native.config.secure_vault().vault_filename,
                            self.client.native.config.secure_vault().vault_filename)
