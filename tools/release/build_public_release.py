"""Build the deterministic, public FargoWork Agent Plugin release.

The builder is deliberately allowlist-first. It never walks the mixed source
workspace looking for files to publish; it validates the explicit public export
manifest, rejects unexpected files and unsafe content, injects the requested
plugin version, and emits only the M3 plugin artifact plus release metadata.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Iterable
from urllib.parse import urlsplit


PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"
DEFAULT_EXPORT_SPEC = Path("public/release/public-export.json")
DEFAULT_VERSION_FILE = Path("public/release/version.json")
DEFAULT_OUTPUT_DIR = Path("dist/release")

SEMVER_RE = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-(?:0|[1-9A-Za-z-][0-9A-Za-z-]*(?:\.[0-9A-Za-z-]+)*))?$"
)
PLUGIN_NAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$")
URL_RE = re.compile(r"https?://[^\s)\]}>\"']+")

# These patterns are intentionally high-signal. Public safety prose may use
# words such as "token" or "secret"; it must not be rejected merely for
# describing what must not be shipped.
SECRET_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"),
    re.compile(r"\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
    re.compile(r"(?i)\b(?:client_secret|access_token|refresh_token|private_key)\b\s*[:=]\s*[\"'][^\"']{8,}[\"']"),
    re.compile(r"(?i)\bauthorization\s*[:=]\s*bearer\s+[A-Za-z0-9._~+/=-]{20,}"),
)


class ReleaseGuardError(ValueError):
    """Raised when a public export violates a fail-closed rule."""


def repo_root_from_script() -> Path:
    return Path(__file__).resolve().parents[2]


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReleaseGuardError(f"cannot read JSON: {path}") from exc
    if not isinstance(value, dict):
        raise ReleaseGuardError(f"JSON object required: {path}")
    return value


def _normalise_relative(value: str, *, label: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ReleaseGuardError(f"unsafe {label}: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts or ".." in path.parts or "." in path.parts:
        raise ReleaseGuardError(f"unsafe {label}: {value!r}")
    if any(not part or part in {".", ".."} for part in path.parts):
        raise ReleaseGuardError(f"unsafe {label}: {value!r}")
    return path


def _is_reparse_or_symlink(path: Path) -> bool:
    if path.is_symlink() or os.path.islink(path):
        return True
    try:
        attributes = path.stat().st_file_attributes
    except (AttributeError, OSError):
        return False
    return bool(attributes & 0x400)  # FILE_ATTRIBUTE_REPARSE_POINT


def _relative_to(root: Path, path: Path) -> PurePosixPath:
    try:
        return PurePosixPath(path.resolve().relative_to(root.resolve()).as_posix())
    except ValueError as exc:
        raise ReleaseGuardError(f"path escapes export root: {path}") from exc


def _load_export_spec(repo_root: Path, spec_path: Path) -> dict[str, Any]:
    spec = _read_json(spec_path)
    if spec.get("schema_version") != 1:
        raise ReleaseGuardError("unsupported public export manifest version")
    source_root_value = spec.get("source_root")
    source_root_rel = _normalise_relative(source_root_value, label="source_root")
    source_root = (repo_root / Path(*source_root_rel.parts)).resolve()
    if not source_root.is_dir() or _is_reparse_or_symlink(source_root):
        raise ReleaseGuardError(f"public export root is not a regular directory: {source_root}")
    files = spec.get("files")
    if not isinstance(files, list) or not files:
        raise ReleaseGuardError("public export files must be a non-empty list")
    normalised_files = [_normalise_relative(item, label="export file") for item in files]
    if len(normalised_files) != len(set(normalised_files)):
        raise ReleaseGuardError("public export files contain duplicates")
    spec["source_root_rel"] = source_root_rel
    spec["source_root"] = source_root
    spec["files"] = sorted(normalised_files, key=str)
    denylist = spec.get("denylist")
    if not isinstance(denylist, dict):
        raise ReleaseGuardError("public export denylist is required")
    for key in ("path_parts", "file_names", "suffixes"):
        if not isinstance(denylist.get(key), list) or not all(
            isinstance(item, str) and item for item in denylist[key]
        ):
            raise ReleaseGuardError(f"public export denylist.{key} is invalid")
    allowed_hosts = spec.get("allowed_url_hosts")
    if not isinstance(allowed_hosts, list) or not all(
        isinstance(host, str) and host == host.lower() and host for host in allowed_hosts
    ):
        raise ReleaseGuardError("public export allowed_url_hosts is invalid")
    return spec


def _check_path_denylist(path: PurePosixPath, spec: dict[str, Any]) -> None:
    denylist = spec["denylist"]
    lowered_parts = {part.lower() for part in path.parts}
    lowered_name = path.name.lower()
    if lowered_parts.intersection(item.lower() for item in denylist["path_parts"]):
        raise ReleaseGuardError(f"denylisted public path: {path}")
    if lowered_name in {item.lower() for item in denylist["file_names"]}:
        raise ReleaseGuardError(f"denylisted public file: {path}")
    if any(lowered_name.endswith(item.lower()) for item in denylist["suffixes"]):
        raise ReleaseGuardError(f"denylisted public suffix: {path}")


def _scan_urls(text: str, path: PurePosixPath, allowed_hosts: set[str]) -> None:
    for raw_url in URL_RE.findall(text):
        parsed = urlsplit(raw_url.rstrip(".,;:"))
        if not parsed.scheme or not parsed.hostname:
            raise ReleaseGuardError(f"invalid URL in public file {path}: {raw_url}")
        if parsed.username or parsed.password or parsed.fragment:
            raise ReleaseGuardError(f"URL contains userinfo or fragment in public file {path}")
        host = parsed.hostname.lower().rstrip(".")
        if host not in allowed_hosts:
            raise ReleaseGuardError(f"unapproved endpoint URL in public file {path}: {host}")


def _scan_content(data: bytes, path: PurePosixPath, spec: dict[str, Any]) -> None:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ReleaseGuardError(f"public release files must be UTF-8 text: {path}") from exc
    for pattern in SECRET_PATTERNS:
        if pattern.search(text):
            raise ReleaseGuardError(f"secret-like content in public file: {path}")
    _scan_urls(text, path, {str(item).lower() for item in spec["allowed_url_hosts"]})


def validate_export_source(spec: dict[str, Any]) -> list[tuple[PurePosixPath, bytes]]:
    """Validate the source tree and return the exact allowlisted payload."""

    source_root: Path = spec["source_root"]
    declared = set(spec["files"])
    actual: set[PurePosixPath] = set()

    for path in sorted(source_root.rglob("*"), key=lambda item: item.as_posix()):
        relative = _relative_to(source_root, path)
        if _is_reparse_or_symlink(path):
            raise ReleaseGuardError(f"symlink or reparse point is not allowed: {relative}")
        if path.is_dir():
            continue
        if not path.is_file():
            raise ReleaseGuardError(f"unsupported public export entry: {relative}")
        _check_path_denylist(relative, spec)
        actual.add(relative)

    missing = declared - actual
    unexpected = actual - declared
    if missing:
        raise ReleaseGuardError(f"allowlisted public files are missing: {sorted(map(str, missing))}")
    if unexpected:
        raise ReleaseGuardError(f"unlisted public files fail closed: {sorted(map(str, unexpected))}")

    payloads: list[tuple[PurePosixPath, bytes]] = []
    for relative in sorted(declared, key=str):
        candidate = source_root.joinpath(*relative.parts)
        if _is_reparse_or_symlink(candidate):
            raise ReleaseGuardError(f"symlink or reparse point is not allowed: {relative}")
        resolved = candidate.resolve()
        _relative_to(source_root, resolved)
        if not resolved.is_file():
            raise ReleaseGuardError(f"allowlisted file is missing: {relative}")
        data = resolved.read_bytes()
        _scan_content(data, relative, spec)
        payloads.append((relative, data))
    return payloads


def _validate_plugin_name(name: Any) -> None:
    if not isinstance(name, str) or not 1 <= len(name) <= 64:
        raise ReleaseGuardError("plugin name must be a 1-64 character string")
    if not PLUGIN_NAME_RE.fullmatch(name) or "--" in name or ".." in name:
        raise ReleaseGuardError(f"invalid Agent Plugins name: {name!r}")


def _validate_skill(skill_dir: Path, relative: PurePosixPath) -> None:
    skill_file = skill_dir / "SKILL.md"
    if _is_reparse_or_symlink(skill_file) or not skill_file.is_file():
        raise ReleaseGuardError(f"skill SKILL.md must be a regular file: {relative}")
    # Git may materialize CRLF on Windows runners. Agent Skill frontmatter is
    # a text contract, so validate normalized line endings without rewriting
    # the packaged source bytes.
    content = skill_file.read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n")
    if not content.startswith("---\n"):
        raise ReleaseGuardError(f"skill frontmatter is missing: {relative}")
    end = content.find("\n---\n", 4)
    if end < 0:
        raise ReleaseGuardError(f"skill frontmatter is not closed: {relative}")
    frontmatter = content[4:end].splitlines()
    fields: dict[str, str] = {}
    for line in frontmatter:
        if not line.strip() or line.startswith(" "):
            continue
        key, separator, value = line.partition(":")
        if separator:
            fields[key.strip()] = value.strip().strip("\"'")
    name = fields.get("name", "")
    description = fields.get("description", "")
    if not 1 <= len(name) <= 64 or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
        raise ReleaseGuardError(f"invalid Agent Skill name: {relative}")
    if name != skill_dir.name:
        raise ReleaseGuardError(f"skill name does not match directory: {relative}")
    if not 1 <= len(description) <= 1024:
        raise ReleaseGuardError(f"invalid Agent Skill description: {relative}")


def validate_plugin_contract(payloads: list[tuple[PurePosixPath, bytes]]) -> dict[str, Any]:
    by_path = {path: data for path, data in payloads}
    plugin_path = PurePosixPath("plugin.json")
    mcp_path = PurePosixPath("mcp.json")
    if plugin_path not in by_path or mcp_path not in by_path:
        raise ReleaseGuardError("public plugin must include plugin.json and mcp.json")
    try:
        plugin = json.loads(by_path[plugin_path].decode("utf-8"))
        mcp = json.loads(by_path[mcp_path].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ReleaseGuardError("plugin.json and mcp.json must be valid UTF-8 JSON") from exc
    if not isinstance(plugin, dict) or not isinstance(mcp, dict):
        raise ReleaseGuardError("plugin.json and mcp.json must be JSON objects")

    allowed_plugin_fields = {
        "$schema",
        "name",
        "version",
        "description",
        "author",
        "homepage",
        "repository",
        "license",
        "keywords",
        "extensions",
    }
    if set(plugin) - allowed_plugin_fields:
        raise ReleaseGuardError("plugin.json has unknown portable top-level fields")
    if plugin.get("$schema") != PLUGIN_SCHEMA:
        raise ReleaseGuardError("plugin.json targets an unsupported Agent Plugins schema")
    _validate_plugin_name(plugin.get("name"))
    if "version" in plugin and not isinstance(plugin["version"], str):
        raise ReleaseGuardError("plugin version must be a string")
    if "description" in plugin and not isinstance(plugin["description"], str):
        raise ReleaseGuardError("plugin description must be a string")
    if "keywords" in plugin and (
        not isinstance(plugin["keywords"], list)
        or not all(isinstance(item, str) for item in plugin["keywords"])
    ):
        raise ReleaseGuardError("plugin keywords must be an array of strings")
    author = plugin.get("author")
    if author is not None and (
        not isinstance(author, dict)
        or set(author) - {"name", "email", "url"}
        or not all(isinstance(item, str) for item in author.values())
    ):
        raise ReleaseGuardError("plugin author must contain only string metadata")
    if "extensions" in plugin and not isinstance(plugin["extensions"], dict):
        raise ReleaseGuardError("plugin extensions must be an object")

    if set(mcp) != {"$schema", "mcpServers"} or mcp.get("$schema") != MCP_SCHEMA:
        raise ReleaseGuardError("mcp.json must use the closed Agent Plugins v1 schema")
    servers = mcp.get("mcpServers")
    if not isinstance(servers, dict):
        raise ReleaseGuardError("mcpServers must be an object")
    for server_name, server in servers.items():
        if not isinstance(server_name, str) or not isinstance(server, dict):
            raise ReleaseGuardError("MCP server names and entries must be objects")
        server_type = server.get("type")
        if server_type == "streamable-http":
            if set(server) - {"type", "url", "headers"} or not isinstance(server.get("url"), str):
                raise ReleaseGuardError(f"invalid streamable-http server entry: {server_name}")
            parsed = urlsplit(server["url"])
            if parsed.scheme not in {"http", "https"} or not parsed.hostname:
                raise ReleaseGuardError(f"MCP URL must be absolute: {server_name}")
            if parsed.username or parsed.password or parsed.fragment:
                raise ReleaseGuardError(f"MCP URL has userinfo or fragment: {server_name}")
            if parsed.hostname.lower() not in {"localhost", "127.0.0.1", "::1"} and parsed.scheme != "https":
                raise ReleaseGuardError(f"non-loopback MCP URL must use HTTPS: {server_name}")
            if "headers" in server:
                headers = server["headers"]
                if not isinstance(headers, dict) or not all(
                    isinstance(key, str) and isinstance(value, str)
                    for key, value in headers.items()
                ):
                    raise ReleaseGuardError(f"MCP headers must be literal strings: {server_name}")
                if any(key.lower() in {"authorization", "cookie", "proxy-authorization"} for key in headers):
                    raise ReleaseGuardError(f"MCP headers cannot carry credentials: {server_name}")
        elif server_type == "stdio":
            if set(server) - {"type", "command", "args", "env", "cwd"}:
                raise ReleaseGuardError(f"invalid stdio server entry: {server_name}")
            command = server.get("command")
            if not isinstance(command, str) or not command or any(char.isspace() for char in command):
                raise ReleaseGuardError(f"stdio command must be one executable token: {server_name}")
            if not (not command.startswith(".") or command.startswith("./")):
                raise ReleaseGuardError(f"stdio command path must be plugin-relative: {server_name}")
            for key in ("args", "env"):
                if key in server and (
                    not isinstance(server[key], (list, dict))
                    or (key == "args" and not all(isinstance(item, str) for item in server[key]))
                    or (key == "env" and not all(
                        isinstance(name, str) and isinstance(value, str)
                        for name, value in server[key].items()
                    ))
                ):
                    raise ReleaseGuardError(f"invalid stdio {key}: {server_name}")
            if "cwd" in server:
                cwd = server["cwd"]
                if not isinstance(cwd, str) or not (
                    cwd == "${PLUGIN_ROOT}"
                    or cwd == "${PLUGIN_DATA}"
                    or cwd.startswith("./")
                    or cwd.startswith("${PLUGIN_ROOT}/")
                    or cwd.startswith("${PLUGIN_DATA}/")
                ):
                    raise ReleaseGuardError(f"stdio cwd must remain plugin/data-relative: {server_name}")
            if isinstance(server.get("env"), dict) and set(server["env"]) & {"PLUGIN_ROOT", "PLUGIN_DATA"}:
                raise ReleaseGuardError(f"stdio may not override reserved environment: {server_name}")
        else:
            raise ReleaseGuardError(f"unsupported MCP server type: {server_name}")

    skill_dirs = sorted(
        {
            path.parent
            for path in by_path
            if len(path.parts) >= 3 and path.parts[0] == "skills" and path.name == "SKILL.md"
        },
        key=str,
    )
    if not skill_dirs:
        raise ReleaseGuardError("public plugin must include at least one Agent Skill")
    for skill_dir in skill_dirs:
        skill_file = PurePosixPath(*skill_dir.parts, "SKILL.md")
        _validate_skill_payload(by_path[skill_file], skill_dir)
    return plugin


def _validate_skill_payload(data: bytes, skill_dir: PurePosixPath) -> None:
    try:
        content = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ReleaseGuardError(f"Agent Skill must be UTF-8: {skill_dir}") from exc
    if not content.startswith("---\n") or "\n---\n" not in content[4:]:
        raise ReleaseGuardError(f"Agent Skill frontmatter is invalid: {skill_dir}")
    end = content.find("\n---\n", 4)
    fields: dict[str, str] = {}
    for line in content[4:end].splitlines():
        if line.startswith(" ") or not line.strip():
            continue
        key, separator, value = line.partition(":")
        if separator:
            fields[key.strip()] = value.strip().strip("\"'")
    name = fields.get("name", "")
    description = fields.get("description", "")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) or name != skill_dir.name:
        raise ReleaseGuardError(f"Agent Skill name does not match its directory: {skill_dir}")
    if not 1 <= len(name) <= 64 or not 1 <= len(description) <= 1024:
        raise ReleaseGuardError(f"Agent Skill metadata length is invalid: {skill_dir}")


def _git_output(repo_root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def _validate_version(value: str) -> str:
    if not isinstance(value, str) or not SEMVER_RE.fullmatch(value):
        raise ReleaseGuardError(f"version must be SemVer without build metadata: {value!r}")
    return value


def load_version(repo_root: Path, version_path: Path) -> str:
    version_info = _read_json(version_path)
    return _validate_version(str(version_info.get("version", "")))


def load_compatibility(version_path: Path) -> dict[str, Any]:
    version_info = _read_json(version_path)
    protocols = version_info.get("mcp_protocol_versions")
    action_contract = version_info.get("action_result_contract")
    agent_plugins_spec = version_info.get("agent_plugins_spec")
    if not isinstance(protocols, list) or not protocols or any(
        not isinstance(value, str) or not value.strip() for value in protocols
    ):
        raise ReleaseGuardError("mcp_protocol_versions must be a non-empty string list")
    if not isinstance(action_contract, int) or action_contract <= 0:
        raise ReleaseGuardError("action_result_contract must be a positive integer")
    if not isinstance(agent_plugins_spec, str) or not agent_plugins_spec.strip():
        raise ReleaseGuardError("agent_plugins_spec is required")
    return {
        "mcp_protocol_versions": list(protocols),
        "action_result_contract": action_contract,
        "agent_plugins_spec": agent_plugins_spec,
    }


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = 0o100644 << 16
    return info


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _render_plugin_payload(payloads: list[tuple[PurePosixPath, bytes]], version: str) -> list[tuple[PurePosixPath, bytes]]:
    rendered: list[tuple[PurePosixPath, bytes]] = []
    for path, data in payloads:
        if path == PurePosixPath("plugin.json"):
            plugin = json.loads(data.decode("utf-8"))
            plugin["version"] = version
            data = _json_bytes(plugin)
        rendered.append((path, data))
    return rendered


def _build_plugin_zip(
    *,
    payloads: list[tuple[PurePosixPath, bytes]],
    version: str,
    output_path: Path,
    compatibility: dict[str, Any],
) -> dict[str, Any]:
    package_files = [
        {
            "path": str(path),
            "size": len(data),
            "sha256": _sha256(data),
        }
        for path, data in payloads
    ]
    package_manifest = {
        "format": "fargowork-agent-plugin-package-manifest/v1",
        "agent_plugins_spec": compatibility["agent_plugins_spec"],
        "mcp_protocol_versions": compatibility["mcp_protocol_versions"],
        "action_result_contract": compatibility["action_result_contract"],
        "name": "fargowork",
        "version": version,
        "files": package_files,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output_path, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path, data in payloads:
            archive.writestr(_zip_info(f"fargowork/{path.as_posix()}"), data)
        archive.writestr(
            _zip_info("fargowork/PACKAGE-MANIFEST.json"),
            _json_bytes(package_manifest),
        )
    return {
        "name": output_path.name,
        "kind": "agent-plugin",
        "status": "emitted",
        "size": output_path.stat().st_size,
        "sha256": _sha256(output_path.read_bytes()),
    }


def _write_checksums(output_dir: Path, artifacts: list[dict[str, Any]]) -> Path:
    path = output_dir / "SHA256SUMS"
    lines = [f"{artifact['sha256']}  {artifact['name']}" for artifact in artifacts]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    return path


def verify_checksums(checksum_path: Path, artifact_dir: Path) -> None:
    lines = checksum_path.read_text(encoding="utf-8").splitlines()
    if not lines:
        raise ReleaseGuardError("SHA256SUMS is empty")
    seen: set[str] = set()
    for line in lines:
        match = re.fullmatch(r"([0-9a-f]{64})  ([^\\/\r\n]+)", line)
        if not match:
            raise ReleaseGuardError(f"invalid SHA256SUMS line: {line!r}")
        digest, name = match.groups()
        if name in seen or name in {"SHA256SUMS", "release-manifest.json"}:
            raise ReleaseGuardError(f"invalid or duplicate checksum subject: {name}")
        seen.add(name)
        artifact = artifact_dir / name
        if not artifact.is_file() or _sha256(artifact.read_bytes()) != digest:
            raise ReleaseGuardError(f"checksum mismatch: {name}")


def build_release(
    *,
    repo_root: Path,
    export_spec_path: Path,
    version_path: Path,
    output_dir: Path,
    version: str | None = None,
) -> dict[str, Any]:
    spec = _load_export_spec(repo_root, export_spec_path)
    payloads = validate_export_source(spec)
    plugin = validate_plugin_contract(payloads)
    resolved_version = _validate_version(version) if version is not None else load_version(repo_root, version_path)
    compatibility = load_compatibility(version_path)
    payloads = _render_plugin_payload(payloads, resolved_version)
    plugin = json.loads(dict(payloads)[PurePosixPath("plugin.json")].decode("utf-8"))
    if plugin["version"] != resolved_version:
        raise ReleaseGuardError("version injection did not update plugin.json")

    if output_dir.exists() and any(output_dir.iterdir()):
        raise ReleaseGuardError(f"output directory must be empty: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)
    plugin_artifact = _build_plugin_zip(
        payloads=payloads,
        version=resolved_version,
        output_path=output_dir / f"fargowork-agent-plugin-v{resolved_version}.zip",
        compatibility=compatibility,
    )
    artifacts = [plugin_artifact]
    checksum_path = _write_checksums(output_dir, artifacts)
    release_manifest = {
        "format": "fargowork-release-manifest/v1",
        "name": "fargowork",
        "version": resolved_version,
        "tag": f"v{resolved_version}",
        "stage": "M4-plugin-source",
        **compatibility,
        "plugin": {
            "artifact": plugin_artifact["name"],
            "package_root": "fargowork/",
            "manifest_path": "fargowork/plugin.json",
            "mcp_config_path": "fargowork/mcp.json",
            "skill_glob": "fargowork/skills/*/SKILL.md",
            "status": "plugin-source-awaits-native-bundle",
        },
        "artifacts": artifacts,
        "reserved_artifacts": spec["reserved_artifacts"],
        "installer_input": {
            "release_tag": f"v{resolved_version}",
            "checksum_file": checksum_path.name,
            "artifact_pattern": "fargowork-{component}-v{version}-{platform}-{arch}.{archive}",
            "status": "emitted-by-m4-native-builder",
        },
        "server_endpoint": {
            "config_key": "FARGOWORK_MCP_ENDPOINT",
            "template": "https://fargowork.ansel.vip/mcp",
            "override_owner": "FargoWork CLI and client adapters",
            "status": "office-pilot",
        },
        "public_private_boundary": {
            "public": ["agent-plugin", "non-sensitive-contracts", "release-metadata"],
            "private": ["server", "workflow-rules", "field-and-permission-facts", "secrets", "production-config", "runtime-data"],
        },
        "source_revision": _git_output(repo_root, "rev-parse", "HEAD") or "unknown",
    }
    manifest_path = output_dir / "release-manifest.json"
    manifest_path.write_bytes(_json_bytes(release_manifest))
    verify_checksums(checksum_path, output_dir)
    return release_manifest


def main(argv: Iterable[str] | None = None) -> int:
    repo_root = repo_root_from_script()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", help="SemVer override; defaults to public/release/version.json")
    parser.add_argument("--export-spec", type=Path, default=repo_root / DEFAULT_EXPORT_SPEC)
    parser.add_argument("--version-file", type=Path, default=repo_root / DEFAULT_VERSION_FILE)
    parser.add_argument("--output-dir", type=Path, default=repo_root / DEFAULT_OUTPUT_DIR)
    parser.add_argument("--check-only", action="store_true", help="Validate the public boundary without writing artifacts")
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        spec = _load_export_spec(repo_root, args.export_spec.resolve())
        payloads = validate_export_source(spec)
        validate_plugin_contract(payloads)
        resolved_version = _validate_version(args.version) if args.version else load_version(repo_root, args.version_file.resolve())
        if args.check_only:
            print(f"Public export check passed: fargowork Agent Plugin {resolved_version}")
            return 0
        manifest = build_release(
            repo_root=repo_root,
            export_spec_path=args.export_spec.resolve(),
            version_path=args.version_file.resolve(),
            output_dir=args.output_dir.resolve(),
            version=args.version,
        )
    except (OSError, ReleaseGuardError, json.JSONDecodeError) as exc:
        print(f"Public release blocked: {exc}")
        return 2
    print(f"Built public release: {args.output_dir.resolve()}")
    print(f"Version: {manifest['version']}")
    print(f"Artifact: {manifest['plugin']['artifact']}")
    print("M4 CLI/bridge artifacts: emitted by build_local_release.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
