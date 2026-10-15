"""Local file transport and durable attachment coordination, never a credential API.

The CLI runtime supplies its existing PKCE/vault implementation. Files travel
directly to the independent HTTP service; only opaque IDs enter business MCP.
"""
from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import ssl
import stat
from urllib.parse import urlsplit
import uuid


DEFAULT_SERVICE = "https://attachments.fargowealthapp.com"
NATIVE_CLIENT = "fargowork-attachments-native"
NATIVE_REDIRECT = "http://127.0.0.1:37681/oauth/callback"
SCOPE = "fargowork:attachments"
MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_JSON_BYTES = 256 * 1024
MAX_FILES = 100
PROCESS = "external_expense_request"
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
_EXTENSIONS = frozenset("pdf jpg jpeg png gif webp txt csv doc docx xls xlsx ppt pptx zip".split())
_FLOW_TYPE = re.compile(r"[A-Za-z0-9_-]{1,100}\Z")
_PENDING_REASONS = frozenset({
    "process_id_missing", "readback_not_configured", "readback_flow_not_configured",
    "readback_identifier_invalid", "readback_timeout", "readback_unavailable",
    "readback_app_auth_unavailable", "readback_upstream_unavailable", "readback_invalid_response",
    "readback_identity_mismatch", "readback_attachment_field_missing", "readback_attachment_value_invalid",
    "readback_attachment_set_mismatch", "readback_confirmation_conflict",
})


class AttachmentError(RuntimeError):
    def __init__(self, code, message, *, kind="input", http_status=None):
        super().__init__(message)
        self.code, self.kind = code, kind
        self.http_status = http_status


def _identifier(value):
    if not isinstance(value, str) or not _UUID.fullmatch(value):
        raise AttachmentError("attachment_input_invalid", "附件操作编号无效。")
    return value


def _ids(values):
    if not isinstance(values, list) or len(values) > MAX_FILES:
        raise AttachmentError("attachment_input_invalid", "附件清单须为不超过100项的编号数组。")
    result = [_identifier(value) for value in values]
    if len(set(result)) != len(result):
        raise AttachmentError("attachment_input_invalid", "附件清单不能重复。")
    return result


def _service(value):
    try:
        parts = urlsplit(value)
        _ = parts.port
        valid = (isinstance(value, str) and value == value.strip() and value == value.rstrip("/")
                 and parts.hostname and not parts.username and not parts.password
                 and not parts.query and not parts.fragment and parts.path in {"", "/"}
                 and "?" not in value and "#" not in value and not any(ord(c) < 33 for c in value)
                 and (parts.scheme == "https" or parts.scheme == "http" and parts.hostname in {"127.0.0.1", "::1"}))
    except (TypeError, ValueError):
        valid = False
    if not valid:
        raise AttachmentError("attachment_configuration_invalid", "附件服务地址配置无效。")
    return value


def _body(result):
    """Read the SDK's single result envelope without changing the MCP response."""
    def invalid():
        raise AttachmentError("attachment_response_invalid", "服务未返回可核实的附件申请结果，已停止继续提交。", kind="transport")

    def unwrap(value):
        if not isinstance(value, dict):
            invalid()
        if "result" in value:
            # MCP SDK wraps the return value of a -> dict tool as {result: ...}.
            # Accept that one known envelope; do not recursively guess through
            # arbitrary nesting or mix flat business fields with an envelope.
            if set(value) != {"result"} or not isinstance(value["result"], dict) or "result" in value["result"]:
                invalid()
            return value["result"]
        return value

    if (not isinstance(result, dict) or result.get("isError") is True
            or "isError" in result and type(result["isError"]) is not bool):
        invalid()
    if "structuredContent" in result and result["structuredContent"] is not None:
        return unwrap(result["structuredContent"])
    content = result.get("content", [])
    if not isinstance(content, list):
        invalid()
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text":
            try:
                text = item.get("text", "")
                if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_JSON_BYTES:
                    invalid()
                value = json.loads(text)
            except (TypeError, ValueError, RecursionError):
                continue
            return unwrap(value)
    invalid()


class AttachmentClient:
    def __init__(self, runtime, config, *, business_session=None, native_session=None):
        self.rt, self.config = runtime, config
        self.service = _service(getattr(config, "attachments_url", DEFAULT_SERVICE))
        self.business = business_session or runtime.TokenSession(config)
        self.identity = None
        self.attachment_issuer = config.effective_attachments_issuer
        native_config = replace(config, issuer=self.attachment_issuer, resource=self.service,
            resource_metadata_uri=self.service + "/.well-known/oauth-protected-resource",
            client_id=NATIVE_CLIENT, redirect_uri=NATIVE_REDIRECT, scope=SCOPE)
        outer = self
        class NativeSession(runtime.TokenSession):
            def me(self):
                return outer._native_identity()
        self.native = native_session or NativeSession(native_config)

    def _native_identity(self):
        _status, value = self._request("GET", "/api/v1/me")
        if (not isinstance(value, dict) or value.get("client_id") != NATIVE_CLIENT
                or value.get("scope") != SCOPE
                or any(not isinstance(value.get(key), str) or not value[key].strip()
                       or len(value[key]) > 256 or any(ord(c) < 32 for c in value[key])
                       for key in ("userid", "corp_id"))):
            raise AttachmentError("attachment_identity_mismatch", "附件身份无法核实，请重新授权。", kind="auth")
        return {key: value.get(key, "") for key in ("userid", "corp_id", "name", "client_id", "scope")}

    def verify(self):
        identity = self.business.me()
        try:
            native = self.native.me()
        except self.rt.FargoWorkError as error:
            if error.code in {"auth_required", "invalid_grant", "invalid_token"}:
                raise AttachmentError("attachment_auth_required", "请先完成附件授权。", kind="auth") from None
            raise
        if any(identity.get(key) != native.get(key) for key in ("userid", "corp_id")):
            raise AttachmentError("attachment_identity_mismatch", "附件登录与当前业务账号不同，请使用同一公司账号重新授权。", kind="auth")
        self.identity = identity
        return identity

    def login(self, *, browser="auto", timeout=300):
        expected = self.business.me()
        _url, native = self.native.login(browser=browser, timeout=timeout)
        if any(expected.get(key) != native.get(key) for key in ("userid", "corp_id")):
            # Revoke only this attachment family; never clear business credentials.
            try:
                self.native.logout()
            finally:
                raise AttachmentError("attachment_identity_mismatch", "附件授权账号与业务账号不同，请重新选择同一账号。", kind="auth")
        self.identity = expected
        self._account_root()
        return {"connected": True, "identity_verified": True}

    def _request(self, method, path, payload=None, *, file=None, batch_id=None):
        token = self.native.access()
        target = urlsplit(self.service)
        connection = (http.client.HTTPSConnection(target.hostname, target.port, timeout=30,
                      context=ssl.create_default_context()) if target.scheme == "https"
                      else http.client.HTTPConnection(target.hostname, target.port, timeout=30))
        headers = {"Authorization": "Bearer " + token, "Accept": "application/json"}
        try:
            if file is None:
                data = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode() if payload is not None else None
                if data is not None:
                    headers["Content-Type"] = "application/json"
                connection.request(method, path, body=data, headers=headers)
            else:
                stream, name, size = file
                boundary = "fargowork-" + uuid.uuid4().hex
                # Quotes, separators and newlines in local names never become headers.
                wire_name = name.replace('"', "_").replace("\\", "_")
                prefix = (f'--{boundary}\r\nContent-Disposition: form-data; name="batch_id"\r\n\r\n{batch_id}\r\n'
                    f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{wire_name}"\r\n'
                    'Content-Type: application/octet-stream\r\n\r\n').encode("utf-8")
                suffix = f"\r\n--{boundary}--\r\n".encode()
                headers.update({"Content-Type": "multipart/form-data; boundary=" + boundary,
                                "Content-Length": str(len(prefix) + size + len(suffix))})
                connection.putrequest(method, path)
                for name_, value_ in headers.items():
                    connection.putheader(name_, value_)
                connection.endheaders()
                connection.send(prefix)
                remaining = size
                while remaining:
                    chunk = stream.read(min(remaining, 1024 * 1024))
                    if not chunk:
                        raise AttachmentError("attachment_upload_unknown", "文件上传结果尚未确认，请勿直接重传。", kind="transport")
                    connection.send(chunk)
                    remaining -= len(chunk)
                if stream.read(1):
                    raise AttachmentError("attachment_upload_unknown", "上传中文件已变化，请保留本次操作供核查。", kind="transport")
                connection.send(suffix)
            response = connection.getresponse()
            raw = response.read(MAX_JSON_BYTES + 1)
            status = response.status
        except (OSError, TimeoutError, http.client.HTTPException):
            raise AttachmentError("attachment_transport_failed", "附件请求结果尚未确认，请勿重复提交流程或盲目重传文件。", kind="transport") from None
        finally:
            connection.close()
        if 300 <= status < 400:
            raise AttachmentError("attachment_response_invalid", "附件接口发生重定向，已停止转发凭据。", kind="transport")
        if status == 401:
            raise AttachmentError("attachment_auth_required", "请先完成附件授权。", kind="auth", http_status=status)
        if not 200 <= status < 300:
            raise AttachmentError("attachment_request_rejected", "附件服务未完成请求，请核对账号、文件或清单；不要重提业务流程。", kind="server", http_status=status)
        try:
            value = json.loads(raw) if len(raw) <= MAX_JSON_BYTES else None
        except (ValueError, UnicodeError):
            value = None
        if not isinstance(value, dict):
            raise AttachmentError("attachment_response_invalid", "附件接口返回无法核实，请保留本次操作供排查。", kind="transport")
        return status, value

    def _account_root(self):
        if self.identity is None:
            self.verify()
        namespace = {"issuer": self.config.issuer, "resource": self.service,
            "environment": self.config.environment, "corp_id": self.identity["corp_id"],
            "userid": self.identity["userid"]}
        # Preserve existing local batches when Auth is inherited. Only an
        # explicitly different attachment Auth creates a new account namespace.
        if self.attachment_issuer != self.config.issuer:
            namespace["attachments_issuer"] = self.attachment_issuer
        fingerprint = hashlib.sha256(json.dumps(namespace, sort_keys=True).encode()).hexdigest()
        root = self.config.home / "attachments" / fingerprint
        self.rt._assert_path_within(self.config.home, root, label="attachment state")
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.rt._assert_safe_tree(root, label="attachment state")
        return root

    @contextmanager
    def state(self, batch_id):
        batch_id = _identifier(batch_id)
        root = self._account_root()
        path = root / (batch_id + ".json")
        self.rt._assert_path_within(self.config.home, path, label="attachment batch")
        with self.rt._vault_refresh_lock(root / (batch_id + ".lock")):
            try:
                if path.stat().st_size > MAX_JSON_BYTES:
                    raise ValueError()
                value = json.loads(path.read_bytes())
                if (not isinstance(value, dict) or value.get("batch_id") != batch_id
                        or value.get("schema_version") != 1 or value.get("process_key") != PROCESS
                        or any(not isinstance(value.get(key), dict) for key in ("files", "uploads", "drafts"))
                        or not isinstance(value.get("selected_ids"), list) or "submission" not in value
                        or value["submission"] is not None and not isinstance(value["submission"], dict)):
                    raise ValueError()
            except (OSError, ValueError, TypeError):
                raise AttachmentError("attachment_state_invalid", "找不到当前账号的有效附件批次。") from None
            try:
                yield value
            except (KeyError, TypeError, AttributeError):
                raise AttachmentError("attachment_state_invalid", "本地附件批次状态损坏，请保留供维护者核查。") from None
            encoded = json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode()
            if len(encoded) > MAX_JSON_BYTES:
                raise AttachmentError("attachment_state_invalid", "附件批次状态超过上限。")
            self.rt._atomic_write(path, encoded)

    def create(self, process_key):
        if process_key != PROCESS:
            raise AttachmentError("attachment_input_invalid", "首轮附件接入只支持对外付款测试流程。")
        self.verify()
        root = self._account_root()
        if sum(1 for _ in root.glob("*.json")) >= 256:
            raise AttachmentError("attachment_state_invalid", "本地附件批次已达上限，请联系维护者整理。")
        batch = str(uuid.uuid4())
        value = {"schema_version": 1, "batch_id": batch, "process_key": process_key,
                 "files": {}, "selected_ids": [], "uploads": {}, "drafts": {}, "submission": None}
        self.rt._atomic_write(root / (batch + ".json"), json.dumps(value, ensure_ascii=True).encode())
        return {"batch_id": batch, "process_key": process_key}

    def _validate_file(self, value):
        if not isinstance(value, dict):
            raise AttachmentError("attachment_response_invalid", "附件上传结果无效。", kind="transport")
        file_id = _identifier(value.get("id"))
        name, size, mime = value.get("name"), value.get("size"), value.get("type")
        if (not isinstance(name, str) or not name or len(name) > 255
                or any(ord(c) < 32 for c in name) or "/" in name or "\\" in name
                or type(size) is not int or not 0 < size <= MAX_FILE_BYTES
                or not isinstance(mime, str) or not mime or len(mime) > 100
                or value.get("downloadUrl") != self.service + "/api/v1/files/" + file_id):
            raise AttachmentError("attachment_response_invalid", "附件服务返回了无法核实的文件信息。", kind="transport")
        return {"id": file_id, "name": name, "size": size, "type": mime,
                "downloadUrl": value["downloadUrl"]}

    def upload(self, batch_id, file_path):
        self.verify()
        path = Path(file_path).absolute()
        if any(self.rt._is_link_or_reparse(part) for part in (path, *path.parents) if part.exists()):
            raise AttachmentError("attachment_input_invalid", "请选择实际的本地文件，不能使用链接或重解析目录。")
        try:
            stream = path.open("rb")
        except OSError:
            raise AttachmentError("attachment_input_invalid", "无法读取所选本地文件。") from None
        with stream:
            info = os.fstat(stream.fileno())
            name, size = path.name, info.st_size
            if (not stat.S_ISREG(info.st_mode) or not 0 < size <= MAX_FILE_BYTES
                    or path.suffix.lower().lstrip(".") not in _EXTENSIONS
                    or len(name) > 255 or any(ord(c) < 32 for c in name)):
                raise AttachmentError("attachment_input_invalid", "文件类型或大小不支持；单文件须为1字节至25MiB。")
            digest = hashlib.sha256()
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
            fingerprint = digest.hexdigest()
            stream.seek(0)
            operation = str(uuid.uuid4())
            with self.state(batch_id) as state:
                if state["submission"] is not None or len(state["files"]) >= MAX_FILES:
                    raise AttachmentError("attachment_input_invalid", "该附件批次不可继续上传。")
                if any(item.get("fingerprint") == fingerprint and item.get("status") == "unknown"
                       for item in state["uploads"].values()):
                    raise AttachmentError("attachment_upload_unknown", "同一文件之前的上传结果尚未确认，请勿直接重传。", kind="transport")
                state["uploads"][operation] = {"fingerprint": fingerprint, "status": "unknown"}
            # Unknown is committed before any bytes leave this process.
            try:
                _status, raw = self._request("POST", "/api/v1/attachments", file=(stream, name, size), batch_id=batch_id)
            except AttachmentError as error:
                if error.http_status in {400, 401, 403, 404, 409, 413, 415, 422}:
                    with self.state(batch_id) as state:
                        state["uploads"][operation]["status"] = "rejected"
                raise
            file = self._validate_file(raw)
            if file["size"] != size or file["name"] != name:
                raise AttachmentError("attachment_response_invalid", "上传返回的文件与所选文件不同。", kind="transport")
            with self.state(batch_id) as state:
                state["files"][file["id"]] = file
                if state["submission"] is None:
                    state["selected_ids"].append(file["id"])
                state["uploads"][operation]["status"] = "done"
                state["selection_synced"] = False
            return {"batch_id": batch_id, "file": file, "selected_ids": state["selected_ids"]}

    def select(self, batch_id, ids):
        self.verify()
        ids = _ids(ids)
        with self.state(batch_id) as state:
            if state["submission"] is not None or any(file_id not in state["files"] for file_id in ids):
                raise AttachmentError("attachment_input_invalid", "只能选择本次已上传且尚未提交的附件。")
            state["selected_ids"] = ids
            state["selection_synced"] = False
        self.sync_selection(batch_id)
        return self.status(batch_id, verified=True)

    def sync_selection(self, batch_id):
        with self.state(batch_id) as state:
            ids = list(state["selected_ids"])
            _status, value = self._request("POST", f"/api/v1/batches/{batch_id}/selection", {"attachment_ids": ids})
            if value.get("batch_id") != batch_id or value.get("status") != "saved" or value.get("attachment_ids") != ids:
                raise AttachmentError("attachment_response_invalid", "最终附件清单尚未得到服务确认。", kind="transport")
            state["selection_synced"] = True

    def status(self, batch_id, *, verified=False):
        if not verified:
            self.verify()
        with self.state(batch_id) as state:
            return {"batch_id": batch_id, "process_key": state["process_key"],
                "selected_ids": list(state["selected_ids"]),
                "files": [state["files"][file_id] for file_id in state["selected_ids"]],
                "upload_result_unknown": any(item.get("status") == "unknown" for item in state["uploads"].values()),
                "submission_state": (state["submission"] or {}).get("state", "not_submitted"),
                "attachment_binding": (state["submission"] or {}).get("binding", "not_requested")}

    def _find_draft(self, draft_id):
        draft_id = _identifier(draft_id)
        matches = []
        for path in self._account_root().glob("*.json"):
            batch = _identifier(path.stem)
            with self.state(batch) as state:
                if draft_id in state["drafts"]:
                    matches.append((batch, deepcopy(state)))
        if len(matches) > 1:
            raise AttachmentError("attachment_state_invalid", "草稿附件关联不明确，已停止提交。")
        return matches[0] if matches else None

    def before_tool(self, name, arguments):
        if name == "prepare_process_draft":
            inputs = arguments.get("user_inputs", {})
            if not isinstance(inputs, dict):
                return None
            nested = inputs.get(PROCESS, {})
            sources = [value for value in (inputs, nested) if isinstance(value, dict) and "attachment_batch_id" in value]
            if not sources:
                return None
            if len(sources) != 1 or arguments.get("process_key") != PROCESS:
                raise AttachmentError("attachment_input_invalid", "附件批次须属于当前付款流程。")
            batch, ids = _identifier(sources[0]["attachment_batch_id"]), _ids(sources[0].get("attachment_ids"))
            self.verify()
            with self.state(batch) as state:
                if state["submission"] is not None or state["selected_ids"] != ids:
                    raise AttachmentError("attachment_input_invalid", "请使用本批次当前最终选择准备申请。")
                # A new preparation invalidates the older exact preview before
                # its request leaves this process, including failed responses.
                state["active_draft_id"] = None
            self.sync_selection(batch)
            return {"batch_id": batch, "attachment_ids": ids}
        if name == "submit_process_draft":
            # A business-only draft must remain independent of attachment setup.
            if not (self.config.home / "attachments").exists():
                return None
            self.identity = self.business.me()
            found = self._find_draft(arguments.get("draft_id"))
            if found is None:
                return None
            self.verify()
            batch, _snapshot = found
            draft = arguments["draft_id"]
            with self.state(batch) as current:
                # Discovery is only a hint. Check and reserve this batch in the
                # same lock so another process cannot replace a sent result/key.
                selection = current["drafts"].get(draft)
                if (current.get("active_draft_id") != draft or not isinstance(selection, dict)
                        or selection.get("attachment_ids") != current["selected_ids"]
                        or current["submission"] is not None):
                    raise AttachmentError("attachment_state_invalid", "申请的附件已变化或提交结果待核查，请勿重复提交。")
                current["submission"] = {"state": "sending", "draft_id": draft,
                    "idempotency_key": "fargowork-" + str(uuid.uuid4()), "binding": "not_requested"}
                context = {"batch_id": batch, **deepcopy(selection)}
            return context
        return None

    def tool_failed(self, name, context):
        if name == "submit_process_draft" and context:
            with self.state(context["batch_id"]) as state:
                state["submission"]["state"] = "unknown"

    def after_tool(self, name, arguments, result, context):
        if not context:
            return None
        try:
            value = _body(result)
        except AttachmentError:
            self.tool_failed(name, context)
            raise
        batch = context["batch_id"]
        if name == "prepare_process_draft":
            returned = value.get("attachment_selection")
            draft_id = value.get("draft_id")
            if isinstance(draft_id, str) and _UUID.fullmatch(draft_id):
                # Remember even a non-ready/malformed response as inactive so
                # that an attempted submit cannot bypass attachment checks by
                # looking like an unrelated business-only draft.
                with self.state(batch) as state:
                    state["drafts"][draft_id] = {"binding_status": "unverified"}
            if (not isinstance(draft_id, str) or not _UUID.fullmatch(draft_id)
                    or type(value.get("ready_to_submit")) is not bool):
                raise AttachmentError("attachment_response_invalid", "申请未返回有效草稿结果，已停止继续提交，请重新准备完整预览。", kind="transport")
            if returned is not None:
                if (not isinstance(returned, dict) or set(returned) != {"batch_id", "attachment_ids", "flow_type"}
                        or returned.get("batch_id") != batch
                        or returned.get("attachment_ids") != context["attachment_ids"]
                        or not isinstance(returned.get("flow_type"), str) or not _FLOW_TYPE.fullmatch(returned["flow_type"])):
                    raise AttachmentError("attachment_response_invalid", "服务返回的附件选择与当前申请不一致。", kind="transport")
            if value.get("ready_to_submit") is True and returned is None:
                raise AttachmentError("attachment_response_invalid", "申请未返回可核实的附件清单，已停止提交。", kind="transport")
            if value["ready_to_submit"] is False:
                # Missing inputs and business rejection are real Server outcomes,
                # not a successful attachment preview or permission to submit.
                return None
            if any(value.get(key) for key in ("errors", "needs_input", "needs_selection", "needs_confirmation", "blocked_by_policy")):
                raise AttachmentError("attachment_response_invalid", "申请准备状态不一致，已停止继续提交，请重新准备完整预览。", kind="transport")
            with self.state(batch) as state:
                if state["selected_ids"] != context["attachment_ids"] or state["submission"] is not None:
                    raise AttachmentError("attachment_state_invalid", "申请的附件选择已变化，请重新准备完整预览。")
                state["active_draft_id"] = draft_id
                state["drafts"][draft_id] = deepcopy(returned)
            return None
        if name == "submit_process_draft":
            process_id = value.get("process_instance_id")
            if value.get("submitted") is True and isinstance(process_id, str) and process_id and len(process_id) <= 256:
                try:
                    with self.state(batch) as state:
                        state["submission"].update(state="submitted", process_id=process_id,
                            flow_type=context["flow_type"], attachment_ids=list(context["attachment_ids"]), binding="pending_confirmation")
                except (AttachmentError, self.rt.FargoWorkError, OSError):
                    # The upstream success is authoritative even if the local
                    # disk cannot save it. The old sending reservation stays.
                    return {"state": "pending_local_recovery", "flow_binding_confirmed": False,
                            "business_submitted": True, "local_result_saved": False,
                            "message": "申请已提交，本机未能保存附件关联结果，请联系维护者核查，勿重新提交流程。"}
                try:
                    return self.notify(batch, verified=True)
                except (AttachmentError, self.rt.FargoWorkError, OSError):
                    return {"state": "pending_confirmation", "flow_binding_confirmed": False,
                            "business_submitted": True, "local_result_saved": True,
                            "message": "申请已提交，附件关联待确认，请勿重新提交流程。"}
            if value.get("status") in {"submission_unknown", "submitting"} or value.get("upstream_outcome") == "submission_unknown":
                self.tool_failed(name, context)
            elif value.get("submitted") is False:
                with self.state(batch) as state:
                    state["submission"] = None
            else:
                self.tool_failed(name, context)
                raise AttachmentError("attachment_response_invalid", "流程结果尚不能完整核实，请保留本次申请供核查，勿重复提交。", kind="transport")
            return None
        return None

    def notify(self, batch_id, *, verified=False):
        if not verified:
            self.verify()
        with self.state(batch_id) as state:
            submission = state["submission"]
            if not isinstance(submission, dict) or submission.get("state") != "submitted":
                raise AttachmentError("attachment_state_invalid", "没有本机已确认成功的流程结果，不能发送附件绑定通知。")
            if submission.get("notice_attempts", 0) >= 3:
                raise AttachmentError("attachment_state_invalid", "附件通知已尝试3次，请联系维护者核查；申请已提交，请勿重提。")
            submission["notice_attempts"] = submission.get("notice_attempts", 0) + 1
            payload = {key: submission[key] for key in ("idempotency_key", "process_id", "flow_type", "attachment_ids")}
        status, value = self._request("POST", f"/api/v1/batches/{batch_id}/submission-notice", payload)
        confirmed = value.get("flow_binding_confirmed")
        if status != 202 or type(confirmed) is not bool or (confirmed and value.get("state") != "confirmed"):
            raise AttachmentError("attachment_response_invalid", "附件引用的确认结果无效，已保留原通知供核查。", kind="transport")
        with self.state(batch_id) as state:
            # Concurrent replies can arrive out of order; a confirmed binding
            # cannot be downgraded by an older pending response.
            confirmed = confirmed or state["submission"].get("binding") == "confirmed"
            state["submission"]["binding"] = "confirmed" if confirmed else "pending_confirmation"
            support = {}
            attempt_id = value.get("attempt_id")
            if isinstance(attempt_id, str) and _UUID.fullmatch(attempt_id):
                support["attempt_id"] = attempt_id
            pending_reason = value.get("pending_reason")
            if not confirmed and isinstance(pending_reason, str) and pending_reason in _PENDING_REASONS:
                support["pending_reason"] = pending_reason
            state["submission"]["last_notice"] = support
        return {"state": "confirmed" if confirmed else "pending_confirmation", "flow_binding_confirmed": confirmed,
                "business_submitted": True, "replayed": value.get("replayed") is True, **support}


def add_parser(subparsers):
    parser = subparsers.add_parser("attachments", help="upload local files and coordinate attachments with the current employee")
    commands = parser.add_subparsers(dest="attachment_action", required=True)
    login = commands.add_parser("login", help="authorize this employee for the independent attachment service")
    login.add_argument("--browser", choices=("auto", "always", "never"), default="auto")
    login.add_argument("--timeout", type=float, default=300)
    create = commands.add_parser("create", help="create a durable batch for one application")
    create.add_argument("--process", default=PROCESS, choices=(PROCESS,))
    upload = commands.add_parser("upload", help="upload one local file once; unknown outcomes are retained")
    upload.add_argument("--batch", required=True)
    upload.add_argument("--file", required=True, type=Path)
    select = commands.add_parser("select", help="replace the final selection without deleting original files")
    select.add_argument("--batch", required=True)
    select.add_argument("--ids", nargs="*", required=True)
    for action in ("status", "notify"):
        command = commands.add_parser(action)
        command.add_argument("--batch", required=True)
    for command in (login, create, upload, select, *[commands.choices[name] for name in ("status", "notify")]):
        command.add_argument("--attempt-id")
        command.add_argument("--output", choices=("json", "jsonl"), default="jsonl")


def run_command(runtime, config, args):
    client = AttachmentClient(runtime, config)
    action = args.attachment_action
    if action == "login":
        value = client.login(browser=args.browser, timeout=args.timeout)
    elif action == "create":
        value = client.create(args.process)
    elif action == "upload":
        value = client.upload(args.batch, args.file)
    elif action == "select":
        value = client.select(args.batch, args.ids)
    elif action == "status":
        value = client.status(args.batch)
    else:
        value = client.notify(args.batch)
    return {"event": "attachment_result", "status": "completed", "action": action, "result": value,
            "automatic_retry_allowed": False}
