"""Native Windows attachment lifecycle against isolated, synthetic loopback APIs.

This validates the actual candidate EXE, two PKCE/DPAPI credential families,
Chinese multipart files and durable submission-notice recovery. It does not
open a browser, use company credentials, contact public APIs, or create a real
workflow. Evidence contains fixed outcomes/counts only, never fixture tokens,
authorization URLs, identities, attachment bodies or employee-facing previews.
"""
from __future__ import annotations

import argparse
import base64
import ctypes
from ctypes import wintypes
from email.parser import BytesParser
from email.policy import default as email_policy
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
import time
from urllib.parse import parse_qs, urlencode, urlsplit
import uuid
import zipfile


BUSINESS_CLIENT = "fargowork-cli"
ATTACHMENT_CLIENT = "fargowork-attachments-native"
BUSINESS_SCOPE = "fargowork:mcp"
ATTACHMENT_SCOPE = "fargowork:attachments"
CALLBACKS = {BUSINESS_CLIENT: "http://127.0.0.1:37680/oauth/callback",
             ATTACHMENT_CLIENT: "http://127.0.0.1:37681/oauth/callback"}
PROCESS = "external_expense_request"
MAX_LINE = 128 * 1024
MAX_EVENTS = 16
ACTIVE_PHASE = "preflight"


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def identifier(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def unprotect_fixture(data):
    """Decrypt only this invocation's newly created synthetic DPAPI slots."""
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
    check(crypt.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 0,
                                  ctypes.byref(result)), "fixture DPAPI decryption failed")
    try:
        return ctypes.string_at(result.data, result.size)
    finally:
        kernel.LocalFree(result.data)


class FixtureServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, _request, _address):
        # Never write a traceback or raw request into the support evidence.
        self.fixture["unexpected"] += 1


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    @property
    def state(self):
        return self.server.fixture

    def reply(self, status, value):
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self, client):
        token = self.state["families"][client]["access"]
        return bool(token) and self.headers.get("Authorization") == "Bearer " + token

    def do_GET(self):
        if self.server.role == "auth" and self.path == "/auth/me" and self.authorized(BUSINESS_CLIENT):
            self.state["business_identity_reads"] += 1
            self.reply(200, {"userid": "fixture-employee", "corp_id": "fixture-company", "name": "测试员工",
                             "scope": BUSINESS_SCOPE})
        elif self.server.role == "attachments" and self.path == "/api/v1/me" and self.authorized(ATTACHMENT_CLIENT):
            self.state["attachment_identity_reads"] += 1
            self.reply(200, {"userid": "fixture-employee", "corp_id": "fixture-company", "name": "测试员工",
                             "client_id": ATTACHMENT_CLIENT, "scope": ATTACHMENT_SCOPE})
        else:
            self.state["unexpected"] += 1
            self.reply(401, {"error": "invalid_token"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        check(0 <= length <= 2 * 1024 * 1024, "fixture request exceeds its bound")
        raw = self.rfile.read(length)
        if self.server.role in ("auth", "attachment-auth") and self.path == "/oauth/token":
            self.token(raw)
        elif self.server.role == "auth" and self.path == "/mcp":
            self.mcp(raw)
        elif self.server.role == "attachments":
            self.attachment(raw)
        else:
            self.state["unexpected"] += 1
            self.reply(404, {})

    def token(self, raw):
        form = {key: values[-1] for key, values in parse_qs(raw.decode("utf-8")).items()}
        client = form.get("client_id")
        family = self.state["families"].get(client)
        check(family is not None and form.get("resource") == family["resource"], "OAuth client/resource isolation failed")
        check(client in self.server.oauth_clients and family["issuer"] == self.server.origin,
              "native OAuth token exchange reached another credential family's issuer")
        grant = form.get("grant_type")
        if grant == "authorization_code":
            challenge = base64.urlsafe_b64encode(hashlib.sha256(form.get("code_verifier", "").encode("ascii")).digest()).rstrip(b"=").decode("ascii")
            check(form.get("code") == family["code"] and form.get("redirect_uri") == CALLBACKS[client]
                  and challenge == family.get("challenge"), "native PKCE code exchange failed")
            family["code_exchanges"] += 1
            check(family["code_exchanges"] == 1, "authorization code was reused")
        else:
            check(grant == "refresh_token" and form.get("scope") == family["scope"]
                  and family["refresh"] and form.get("refresh_token") == family["refresh"], "native refresh crossed credential families")
            family["refresh_exchanges"] += 1
        family["refresh"] = "fixture-refresh-" + secrets.token_hex(24)
        family["access"] = "fixture-access-" + secrets.token_hex(24)
        self.state["issued_tokens"].extend((family["refresh"], family["access"]))
        self.reply(200, {"token_type": "Bearer", "access_token": family["access"],
                         "refresh_token": family["refresh"], "expires_in": 600, "scope": family["scope"]})

    def mcp(self, raw):
        check(self.authorized(BUSINESS_CLIENT), "business request used the wrong credential family")
        message = json.loads(raw)
        method = message.get("method")
        check(self.headers.get("MCP-Protocol-Version") == "2026-07-28"
              and self.headers.get("Mcp-Method") == method, "native business request omitted modern headers")
        if method == "server/discover":
            result = {"supportedVersions": ["2026-07-28"], "capabilities": {"tools": {"listChanged": False}},
                      "serverInfo": {"name": "isolated-native-attachments-fixture", "version": "1"}}
        elif method == "tools/list":
            schemas = {"prepare_process_draft": {"process_key": {"type": "string"}, "user_inputs": {"type": "object"}},
                       "submit_process_draft": {"draft_id": {"type": "string"}}}
            result = {"tools": [{"name": name, "description": "synthetic local workflow", "inputSchema": {
                      "type": "object", "properties": properties, "additionalProperties": False}} for name, properties in schemas.items()]}
        elif method == "tools/call":
            params = message.get("params", {})
            name, arguments = params.get("name"), params.get("arguments", {})
            check(self.headers.get("Mcp-Name") == name, "native business tool header is invalid")
            if name == "prepare_process_draft":
                inputs = arguments.get("user_inputs", {})
                batch, ids = inputs.get("attachment_batch_id"), inputs.get("attachment_ids")
                check(arguments.get("process_key") == PROCESS and batch == self.state["batch"]
                      and ids == self.state["selection"] and inputs.get("reason") == "个人事务中文附件测试",
                      "native preview inputs or Chinese JSON were corrupted")
                self.state["prepare_calls"] += 1
                value = {"status": "ready_for_preview", "ready_to_submit": True, "draft_id": self.state["draft"],
                         "attachment_selection": {"batch_id": batch, "attachment_ids": ids, "flow_type": "external-payment"},
                         "semantic_preview": {"reason": inputs["reason"], "attachments": [self.state["files"][item]["name"] for item in ids]}}
            else:
                check(name == "submit_process_draft" and arguments.get("draft_id") == self.state["draft"], "native submit used an unexpected draft")
                self.state["submit_calls"] += 1
                check(self.state["submit_calls"] == 1, "native CLI repeated business submission")
                value = {"status": "submitted", "submitted": True, "process_instance_id": "fixture-native-attachment-process",
                         "action_result": {"display_message": "申请已提交。", "automatic_retry_allowed": False}}
            # SDK2 wraps a dict-returning tool in an additional ``result``
            # envelope. Keep both wire forms exact: the old flat fixture hid a
            # real CLI bug that silently lost draft/attachment coordination.
            envelope = {"result": value}
            result = {"content": [{"type": "text", "text": json.dumps(envelope, ensure_ascii=False)}],
                      "isError": False}
            if self.state["result_format"] == "sdk":
                result["structuredContent"] = envelope
        else:
            raise RuntimeError("unexpected native MCP method")
        self.reply(200, {"jsonrpc": "2.0", "id": message.get("id"), "result": result})

    def attachment(self, raw):
        check(self.authorized(ATTACHMENT_CLIENT), "attachment API received the business credential family")
        if self.path == "/api/v1/attachments":
            check(self.headers.get("Content-Type", "").startswith("multipart/form-data; boundary="), "native file upload was not multipart")
            parsed = BytesParser(policy=email_policy).parsebytes(b"Content-Type: " + self.headers["Content-Type"].encode("ascii") + b"\r\n\r\n" + raw)
            fields = {part.get_param("name", header="content-disposition"): part for part in parsed.iter_parts()}
            check(set(fields) == {"batch_id", "file"}, "multipart fields differ from the official contract")
            batch = fields["batch_id"].get_content().strip()
            check(identifier(batch) and self.state["batch"] in (None, batch), "upload escaped its durable batch")
            self.state["batch"] = batch
            part = fields["file"]
            name, body = part.get_filename(), part.get_payload(decode=True)
            check(name in self.state["expected_files"] and body == self.state["expected_files"][name], "native multipart Chinese name or bytes were corrupted")
            file_id = str(uuid.uuid4())
            file = {"id": file_id, "name": name, "size": len(body), "type": "application/pdf",
                    "downloadUrl": self.state["attachment_origin"] + "/api/v1/files/" + file_id}
            self.state["files"][file_id] = file
            self.reply(200, file)
        elif self.path == f"/api/v1/batches/{self.state['batch']}/selection":
            value = json.loads(raw)
            ids = value.get("attachment_ids")
            check(set(value) == {"attachment_ids"} and isinstance(ids, list)
                  and all(item in self.state["files"] for item in ids), "native selection includes an unknown file")
            self.state["selection"] = ids
            self.reply(200, {"batch_id": self.state["batch"], "attachment_ids": ids, "status": "saved"})
        elif self.path == f"/api/v1/batches/{self.state['batch']}/submission-notice":
            value = json.loads(raw)
            check(set(value) == {"idempotency_key", "process_id", "flow_type", "attachment_ids"}
                  and value.get("process_id") == "fixture-native-attachment-process"
                  and value.get("flow_type") == "external-payment"
                  and value.get("attachment_ids") == self.state["selection"], "notice differs from the confirmed application snapshot")
            self.state["notices"].append(value)
            if len(self.state["notices"]) == 1:
                # Accept the exact snapshot, then lose ONLY the response.
                self.close_connection = True
                return
            check(value == self.state["notices"][0], "attachment notice retry changed its idempotency key or snapshot")
            self.reply(202, {"state": "confirmed", "flow_binding_confirmed": True, "replayed": True})
        else:
            raise RuntimeError("unexpected native attachment endpoint")


def native(exe, arguments, env, cwd, state, *, input_object=None, success=True):
    global ACTIVE_PHASE
    ACTIVE_PHASE = "attachment_" + arguments[1] if arguments[0] == "attachments" else "business_" + arguments[2]
    result = subprocess.run([str(exe), *arguments, "--output", "jsonl"], env=env, cwd=cwd,
        input=json.dumps(input_object, ensure_ascii=False) if input_object is not None else "",
        capture_output=True, text=True, encoding="utf-8", timeout=45)
    lines = result.stdout.splitlines()
    check(len(lines) == 1 and not result.stderr.strip(), "native business command emitted progress, raw stderr or multiple results")
    check(len(lines[0].encode("utf-8")) <= MAX_LINE, "native business result exceeds its bound")
    check(all(token not in result.stdout for token in state["issued_tokens"]), "native command exposed a fixture credential")
    value = json.loads(lines[0])
    check(isinstance(value, dict), "native command did not return a structured result")
    if success:
        check(result.returncode == 0 and value.get("status") == "completed", "native attachment/business command failed")
    else:
        check(result.returncode != 0 and value.get("event") == "error", "native command failed to reject a repeated submit")
    return value


def business_body(event, result_format):
    """Inspect the independently specified SDK wire form, never product _body."""
    result = event["result"]
    text_items = [item for item in result.get("content", []) if item.get("type") == "text"]
    check(len(text_items) == 1, "native tool response omitted its one wrapped JSON text result")
    text = json.loads(text_items[0]["text"])
    check(isinstance(text, dict) and set(text) == {"result"} and isinstance(text["result"], dict),
          "native tool output did not preserve the wrapped JSON business contract")
    if result_format == "sdk":
        structured = result.get("structuredContent")
        check(isinstance(structured, dict) and set(structured) == {"result"}
              and structured == text, "native tool output changed the SDK structuredContent.result envelope")
    else:
        check("structuredContent" not in result, "text fallback fixture unexpectedly returned structured content")
    return text["result"]


def login(exe, client, env, cwd, state):
    global ACTIVE_PHASE
    ACTIVE_PHASE = "oauth_business" if client == BUSINESS_CLIENT else "oauth_attachments"
    arguments = ["login"] if client == BUSINESS_CLIENT else ["attachments", "login"]
    process = subprocess.Popen([str(exe), *arguments, "--browser", "never", "--timeout", "25", "--output", "jsonl"],
        env=env, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8")
    events = queue.Queue()
    def read():
        try:
            for _ in range(MAX_EVENTS):
                line = process.stdout.readline(MAX_LINE + 1)
                if not line:
                    break
                check(len(line.encode("utf-8")) <= MAX_LINE, "login event exceeds its bound")
                events.put(json.loads(line))
        except (OSError, ValueError, RuntimeError):
            events.put({"event": "invalid_output"})
        finally:
            events.put({"event": "eof"})
    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    try:
        try:
            first = events.get(timeout=20)
        except queue.Empty:
            raise RuntimeError("native OAuth authorization event timed out") from None
        check(first.get("event") == "login_authorization_url", "native OAuth did not emit its explicit manual authorization event")
        parsed = urlsplit(first.get("url", ""))
        family = state["families"][client]
        check(parsed.scheme + "://" + parsed.netloc == family["issuer"] and parsed.path == "/oauth/authorize", "native OAuth authorization origin escaped its configured issuer")
        params = parse_qs(parsed.query)
        check(params.get("client_id") == [client] and params.get("resource") == [family["resource"]]
              and params.get("scope") == [family["scope"]] and params.get("redirect_uri") == [CALLBACKS[client]]
              and params.get("code_challenge_method") == ["S256"], "native OAuth client/scope/resource/redirect contract differs")
        family["challenge"] = params["code_challenge"][0]
        callback_url = urlsplit(CALLBACKS[client])
        callback = http.client.HTTPConnection("127.0.0.1", callback_url.port, timeout=5)
        try:
            callback.request("GET", callback_url.path + "?" + urlencode({"state": params["state"][0], "code": family["code"], "iss": family["issuer"]}))
            response = callback.getresponse()
            check(response.status == 200, "native OAuth fixture callback was rejected")
            response.read()
        finally:
            callback.close()
        terminal = events.get(timeout=20)
        expected = "logged_in" if client == BUSINESS_CLIENT else "attachment_result"
        check(terminal.get("event") == expected and process.wait(timeout=10) == 0, "native OAuth terminal result failed")
        check(events.get(timeout=5).get("event") == "eof", "native OAuth produced unexpected phase output")
        check(not process.stderr.read().strip(), "native OAuth emitted raw stderr")
        verified = terminal if client == BUSINESS_CLIENT else terminal.get("result", {})
        check(verified.get("identity_verified") is True and verified.get("connected") is True, "native OAuth identity was not verified")
        check(all(token not in json.dumps(terminal) for token in state["issued_tokens"]), "native OAuth terminal result exposed a fixture token")
    except queue.Empty:
        raise RuntimeError("native OAuth terminal event timed out") from None
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
        reader.join(timeout=5)
        process.stdout.close()
        process.stderr.close()


def vaults(home, state, expected):
    slots = list(home.glob("vault.*.dpapi"))
    check(len(slots) == len(expected), "native credential slots collided or were duplicated")
    plaintext = set()
    for path in slots:
        raw = path.read_bytes()
        check(all(token.encode("utf-8") not in raw for token in state["issued_tokens"]), "fixture vault contains plaintext credentials")
        plaintext.add(unprotect_fixture(raw))
    check(plaintext == {state["families"][client]["refresh"].encode("utf-8") for client in expected}, "native DPAPI slots overwrote another credential family")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--result-format", choices=("sdk", "text"), default="sdk",
                        help="SDK structuredContent.result plus wrapped text, or wrapped JSON text only")
    parser.add_argument("--independent-attachment-issuer", action="store_true",
                        help="Use a third synthetic loopback origin for attachment OAuth, separate from business Auth")
    args = parser.parse_args()
    check(os.name == "nt", "native attachment acceptance requires Windows")
    archive = args.archive.resolve(strict=True)
    # Fail before launching an EXE when either fixed callback is already in use.
    for callback in CALLBACKS.values():
        probe = socket.socket()
        try:
            probe.bind(("127.0.0.1", urlsplit(callback).port))
        except OSError:
            raise RuntimeError("native callback port is occupied; no fixture login was started") from None
        finally:
            probe.close()
    state = {"families": {}, "issued_tokens": [], "files": {}, "batch": None, "selection": [],
             "result_format": args.result_format,
             "draft": str(uuid.uuid4()), "prepare_calls": 0, "submit_calls": 0, "notices": [],
             "unexpected": 0, "business_identity_reads": 0, "attachment_identity_reads": 0,
             "expected_files": {"报销材料一.pdf": b"%PDF-1.4 synthetic first attachment\n",
                                "报销材料二.pdf": b"%PDF-1.4 synthetic selected attachment\n"}}
    auth = FixtureServer(("127.0.0.1", 0), Handler)
    attachment = FixtureServer(("127.0.0.1", 0), Handler)
    auth.role, attachment.role = "auth", "attachments"
    servers = [auth, attachment]
    native_auth = auth
    if args.independent_attachment_issuer:
        native_auth = FixtureServer(("127.0.0.1", 0), Handler)
        native_auth.role = "attachment-auth"
        servers.append(native_auth)
    for server in servers:
        server.fixture = state
        server.origin = f"http://127.0.0.1:{server.server_port}"
        server.oauth_clients = set()
    auth.oauth_clients.add(BUSINESS_CLIENT)
    native_auth.oauth_clients.add(ATTACHMENT_CLIENT)
    state["issuer"] = f"http://127.0.0.1:{auth.server_port}"
    state["attachment_issuer"] = native_auth.origin
    state["attachment_origin"] = f"http://127.0.0.1:{attachment.server_port}"
    for client, resource, scope in ((BUSINESS_CLIENT, state["issuer"] + "/mcp", BUSINESS_SCOPE),
                                     (ATTACHMENT_CLIENT, state["attachment_origin"], ATTACHMENT_SCOPE)):
        issuer = state["issuer"] if client == BUSINESS_CLIENT else state["attachment_issuer"]
        state["families"][client] = {"issuer": issuer, "resource": resource, "scope": scope, "access": "", "refresh": "",
            "code": "fixture-code-" + secrets.token_hex(16), "code_exchanges": 0, "refresh_exchanges": 0}
    threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in servers]
    for thread in threads:
        thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="fargowork-native-attachments-") as temporary:
            root = Path(temporary)
            profile = root / "隔离中文员工资料"
            profile.mkdir()
            with zipfile.ZipFile(archive) as outer:
                check(not any("bridge" in name.lower() for name in outer.namelist()), "native candidate still ships a Bridge archive")
                names = [name for name in outer.namelist() if name.startswith("fargowork-cli-v") and name.endswith("-windows-x64.zip")]
                check(len(names) == 1, "native candidate must contain exactly one CLI archive")
                data = outer.read(names[0])
                manifest = json.loads(outer.read("release-manifest.json"))
                expected = [item for item in manifest["artifacts"] if item["name"] == names[0]]
                check(len(expected) == 1 and hashlib.sha256(data).hexdigest() == expected[0]["sha256"]
                      and len(data) == expected[0]["size"], "native CLI archive checksum differs")
                with zipfile.ZipFile(io.BytesIO(data)) as inner:
                    check(inner.namelist().count("fargowork.exe") == 1, "native candidate EXE is missing or duplicated")
                    exe = root / "fargowork.exe"
                    exe.write_bytes(inner.read("fargowork.exe"))
            env = {key: value for key, value in os.environ.items()
                   if not key.upper().startswith("FARGOWORK_") and not key.upper().endswith("_PROXY")}
            env.update(USERPROFILE=str(profile), HOME=str(profile), APPDATA=str(profile / "AppData/Roaming"),
                LOCALAPPDATA=str(profile / "AppData/Local"), CODEX_HOME=str(profile / ".codex"), CLAUDE_CONFIG_DIR="",
                TEMP=str(root / "temporary"), TMP=str(root / "temporary"), NO_PROXY="*", no_proxy="*", PYTHONIOENCODING="utf-8")
            (root / "temporary").mkdir()
            home = Path(env["APPDATA"]) / "FargoWork/employee"
            home.mkdir(parents=True)
            config = {"environment": "employee", "issuer": state["issuer"],
                "resource": state["issuer"] + "/mcp", "resource_metadata_uri": state["issuer"] + "/.well-known/oauth-protected-resource",
                "client_id": BUSINESS_CLIENT, "redirect_uri": CALLBACKS[BUSINESS_CLIENT],
                "attachments_url": state["attachment_origin"]}
            if args.independent_attachment_issuer:
                config["attachments_issuer"] = state["attachment_issuer"]
            (home / "config.json").write_text(json.dumps(config), encoding="utf-8")
            rejected = subprocess.run([str(exe), "bridge"], env=env, cwd=root, capture_output=True, timeout=20)
            check(rejected.returncode == 2, "retired Bridge command is still accepted")
            login(exe, BUSINESS_CLIENT, env, root, state)
            vaults(home, state, [BUSINESS_CLIENT])
            login(exe, ATTACHMENT_CLIENT, env, root, state)
            vaults(home, state, [BUSINESS_CLIENT, ATTACHMENT_CLIENT])
            created = native(exe, ["attachments", "create"], env, root, state)["result"]
            batch = created.get("batch_id")
            check(identifier(batch) and created.get("process_key") == PROCESS, "native durable batch was not created")
            ids = []
            for name, body in state["expected_files"].items():
                path = profile / name
                path.write_bytes(body)
                value = native(exe, ["attachments", "upload", "--batch", batch, "--file", str(path)], env, root, state)["result"]
                file = value.get("file", {})
                check(value.get("batch_id") == batch and file.get("name") == name and file.get("size") == len(body), "native upload returned corrupted Chinese file metadata")
                ids.append(file["id"])
            selected = native(exe, ["attachments", "select", "--batch", batch, "--ids", ids[1]], env, root, state)["result"]
            check(selected.get("selected_ids") == [ids[1]] and len(state["files"]) == 2, "native final selection deleted originals or selected wrong files")
            preview = native(exe, ["tools", "call", "prepare_process_draft"], env, root, state, input_object={
                "process_key": PROCESS, "user_inputs": {"attachment_batch_id": batch, "attachment_ids": [ids[1]], "reason": "个人事务中文附件测试"}})
            prepared = business_body(preview, args.result_format)
            check(prepared.get("attachment_selection") == {"batch_id": batch, "attachment_ids": [ids[1]], "flow_type": "external-payment"}
                  and prepared.get("ready_to_submit") is True, "native preview did not return a canonical selection")
            submitted = native(exe, ["tools", "call", "submit_process_draft"], env, root, state,
                               input_object={"draft_id": prepared["draft_id"]})
            check(business_body(submitted, args.result_format).get("submitted") is True
                  and submitted.get("attachment_binding", {}).get("business_submitted") is True
                  and submitted["attachment_binding"].get("flow_binding_confirmed") is False,
                  "lost attachment notice changed a successful business submission")
            pending = native(exe, ["attachments", "status", "--batch", batch], env, root, state)["result"]
            check(pending.get("submission_state") == "submitted" and pending.get("attachment_binding") == "pending_confirmation",
                  "lost notice did not preserve the successful local submission")
            notice = native(exe, ["attachments", "notify", "--batch", batch], env, root, state)["result"]
            check(notice.get("flow_binding_confirmed") is True and notice.get("replayed") is True
                  and len(state["notices"]) == 2 and state["notices"][0] == state["notices"][1], "native notification recovery changed the key/snapshot")
            native(exe, ["tools", "call", "submit_process_draft"], env, root, state,
                   input_object={"draft_id": prepared["draft_id"]}, success=False)
            check(state["submit_calls"] == 1 and state["prepare_calls"] == 1 and state["unexpected"] == 0,
                  "native fixture observed repeated business calls or an unexpected request")
            vaults(home, state, [BUSINESS_CLIENT, ATTACHMENT_CLIENT])
            check(all(state["families"][client]["code_exchanges"] == 1 and state["families"][client]["refresh_exchanges"] > 0 for client in CALLBACKS),
                  "native attachment fixture did not exercise both OAuth families and refresh")
            check(not any((profile / name).exists() for name in (".codex", ".cursor", ".claude", ".claude.json", ".codebuddy")),
                  "native CLI created host MCP or Skill configuration")
            forbidden = [token.encode("utf-8") for token in state["issued_tokens"]]
            forbidden += [value.encode("utf-8") for value in ("fixture-employee", "fixture-company", *state["expected_files"])]
            diagnostics = Path(env["APPDATA"]) / "FargoWork/diagnostics"
            for path in diagnostics.glob("diagnostic-*.jsonl"):
                data = path.read_bytes()
                check(not any(value in data for value in forbidden), "native diagnostics contains identity, filenames or credentials")
            evidence = {"event": "native_attachment_fixture", "status": "PASS", "archive": archive.name,
                "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "native_exe": True,
                "pkce_clients": 2, "dpapi_slots": 2, "uploaded_files": len(state["files"]),
                "independent_attachment_issuer": args.independent_attachment_issuer,
                "oauth_authority_origins": 2 if args.independent_attachment_issuer else 1,
                "issuer_isolation_verified": True,
                "selected_files": len(state["selection"]), "business_prepare_calls": state["prepare_calls"],
                "business_submit_calls": state["submit_calls"], "notice_attempts": len(state["notices"]),
                "notice_same_key_snapshot": True, "lost_notice_preserved_success": True,
                "repeated_submit_rejected": True, "chinese_json_and_multipart": True,
                "mcp_result_envelope": "structuredContent.result+text.result" if args.result_format == "sdk" else "text.result-only",
                "one_final_business_json": True, "credentials_not_output": True,
                "host_configuration_unchanged": True, "bridge_unavailable": True,
                "real_company_api": "NOT_RUN", "real_employee_oauth": "NOT_RUN",
                "actual_attachment_api_workflow_integration": "NOT_RUN: separate cross-repository test"}
        if args.evidence:
            destination = args.evidence.absolute()
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("x", encoding="utf-8") as output:
                output.write(json.dumps(evidence, ensure_ascii=True, indent=2) + "\n")
        print(json.dumps(evidence, ensure_ascii=True, separators=(",", ":")))
        return 0
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
        for thread in threads:
            thread.join(timeout=5)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"event": "native_attachment_fixture", "status": "FAIL",
                          "phase": ACTIVE_PHASE,
                          "message": str(error) if type(error) is RuntimeError else "Isolated fixture verification did not complete.",
                          "real_company_api": "NOT_RUN"}))
        raise SystemExit(1)
