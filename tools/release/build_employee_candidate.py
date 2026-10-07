"""Build a locally distributable, allowlist-checked Windows employee candidate."""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
CLIENT_VERSION_FILE = ROOT / "public" / "release" / "version.json"
SERVER_VERSION_FILE = ROOT / "server" / "release" / "version.json"
EXPORT_FILE = ROOT / "public" / "release" / "public-export.json"
NATIVE_BUILDER = ROOT / "tools" / "release" / "build_local_release.py"
PUBLIC_BUILDER = ROOT / "tools" / "release" / "build_public_release.py"
INSTALLER = ROOT / "public" / "install.ps1"
EMPLOYEE_README = ROOT / "public" / "EMPLOYEE-README.md"
DATA_NOTE = ROOT / "public" / "EMPLOYEE-DATA-NOTE.md"
DEBUG_NOTE = ROOT / "public" / "DEBUG.md"
if not DEBUG_NOTE.exists():
    DEBUG_NOTE = ROOT / "DEBUG.md"
SOURCE_ALLOWLIST = (
    "public/cli/fargowork_cli.py",
    "public/cli/client_diagnostics.py",
    "public/cli/employee_profile.py",
    "public/install.ps1",
    "public/EMPLOYEE-README.md",
    "public/EMPLOYEE-DATA-NOTE.md",
    DEBUG_NOTE.relative_to(ROOT).as_posix(),
    "public/release/public-export.json",
    "public/release/version.json",
    "tools/release/build_public_release.py",
    "tools/release/build_local_release.py",
    "tools/release/build_employee_candidate.py",
)
BUNDLE_FIXED_FILES = {
    "README.md",
    "DATA-AND-SUPPORT.md",
    "DEBUG.md",
    "install.ps1",
    "release-manifest.json",
    "SHA256SUMS",
    "candidate-manifest.json",
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"expected a JSON object: {path}")
    return payload


def _git(*args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=ROOT,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def _source_manifest() -> dict[str, Any]:
    export = _read_json(EXPORT_FILE)
    source_root = ROOT / Path(*PurePosixPath(export["source_root"]).parts)
    paths = set(SOURCE_ALLOWLIST)
    paths.update(
        (PurePosixPath(export["source_root"]) / PurePosixPath(item)).as_posix()
        for item in export["files"]
    )
    entries = []
    for relative in sorted(paths):
        path = ROOT / Path(*PurePosixPath(relative).parts)
        if not path.is_file() or path.is_symlink():
            raise FileNotFoundError(f"allowlisted candidate source is missing or unsafe: {relative}")
        entries.append({"path": relative, "sha256": sha256_file(path)})
    material = b"".join(
        entry["path"].encode("utf-8") + b"\0" + bytes.fromhex(entry["sha256"])
        for entry in entries
    )
    return {
        "sha256": sha256_bytes(material),
        "files": entries,
        "plugin_source_root": str(source_root.relative_to(ROOT)).replace("\\", "/"),
        "plugin_export_count": len(export["files"]),
    }


def _zip_tree(root: Path, target: Path) -> None:
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as output:
        for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
            if not path.is_file():
                continue
            relative = path.relative_to(root).as_posix()
            info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            output.writestr(info, path.read_bytes())


def _verify_native_artifacts(native_dir: Path, version: str) -> tuple[list[Path], dict[str, Any]]:
    manifest = _read_json(native_dir / "release-manifest.json")
    expected_names = {
        f"fargowork-cli-v{version}-windows-x64.zip",
        f"fargowork-bridge-v{version}-windows-x64.zip",
        f"fargowork-agent-plugin-v{version}-windows-x64.zip",
    }
    actual_archives = {path.name for path in native_dir.glob("*.zip")}
    if actual_archives != expected_names:
        raise RuntimeError(f"unexpected native artifact set: {sorted(actual_archives)}")
    if manifest.get("version") != version or manifest.get("platform") != "windows" or manifest.get("arch") != "x64":
        raise RuntimeError("native release manifest does not match the employee candidate")
    plugin_archive = native_dir / f"fargowork-agent-plugin-v{version}-windows-x64.zip"
    with zipfile.ZipFile(plugin_archive) as archive:
        names = set(archive.namelist())
        plugin_data = json.loads(archive.read("fargowork/plugin.json").decode("utf-8"))
        mcp_data = json.loads(archive.read("fargowork/mcp.json").decode("utf-8"))
        package_data = json.loads(archive.read("fargowork/PACKAGE-MANIFEST.json").decode("utf-8"))
        if plugin_data.get("name") != "fargowork-employee" or plugin_data.get("version") != version:
            raise RuntimeError("native plugin identity or version is not the employee candidate")
        if set(mcp_data.get("mcpServers", {})) != {"fargowork-employee"}:
            raise RuntimeError("native plugin MCP registration is not isolated to employee")
        if package_data.get("mcp_protocol_versions") != ["2026-07-28"]:
            raise RuntimeError("employee package does not declare the required Server MCP contract")
        export_spec = _read_json(EXPORT_FILE)
        expected_members = {
            "fargowork/PACKAGE-MANIFEST.json",
            "fargowork/bin/fargowork.exe",
            *(
                (PurePosixPath("fargowork") / PurePosixPath(item)).as_posix()
                for item in export_spec["files"]
            ),
        }
        if names != expected_members:
            raise RuntimeError(
                "employee plugin archive does not match the declared file allowlist: "
                f"missing={sorted(expected_members - names)}, unexpected={sorted(names - expected_members)}"
            )
        forbidden_parts = {"services", "private", "data", "logs", "state", "secrets"}
        for name in names:
            normalised = name.replace("\\", "/")
            parts = {part.lower() for part in PurePosixPath(normalised).parts}
            if parts & forbidden_parts or normalised.lower().endswith((".env", ".pem", ".key", ".pfx")):
                raise RuntimeError(f"forbidden employee package entry: {name}")
    artifacts = [native_dir / name for name in sorted(expected_names)]
    return artifacts, manifest


def build(*, platform_name: str, arch: str, output_dir: Path) -> dict[str, Any]:
    if platform_name != "windows" or arch != "x64":
        raise ValueError("the first employee candidate supports Windows x64 only")
    if platform.system() != "Windows" or platform.machine().lower() not in {"amd64", "x86_64"}:
        raise RuntimeError("the employee candidate must be built on a native Windows x64 host")
    if output_dir.exists() and any(output_dir.iterdir()):
        raise RuntimeError(f"output directory must be empty: {output_dir}")

    client_version = str(_read_json(CLIENT_VERSION_FILE).get("version") or "")
    # Public client checkouts intentionally contain no Server source tree.
    server_version = (
        str(_read_json(SERVER_VERSION_FILE).get("version") or "")
        if SERVER_VERSION_FILE.is_file() else "not-specified"
    )
    if not client_version:
        raise RuntimeError("employee client version is missing")
    source = _source_manifest()
    output_dir.mkdir(parents=True, exist_ok=True)
    bundle_name = f"fargowork-employee-v{client_version}-windows-x64.zip"
    with tempfile.TemporaryDirectory(prefix="fargowork-employee-candidate-") as temporary:
        staging = Path(temporary)
        native_dir = staging / "native"
        subprocess.run(
            [
                sys.executable,
                str(NATIVE_BUILDER),
                "--version",
                client_version,
                "--platform",
                platform_name,
                "--arch",
                arch,
                "--output-dir",
                str(native_dir),
            ],
            cwd=ROOT,
            check=True,
        )
        artifacts, native_manifest = _verify_native_artifacts(native_dir, client_version)
        bundle_root = staging / "bundle"
        bundle_root.mkdir()
        for artifact in artifacts:
            shutil.copy2(artifact, bundle_root / artifact.name)
        shutil.copy2(INSTALLER, bundle_root / "install.ps1")
        employee_readme = EMPLOYEE_README.read_text(encoding="utf-8")
        employee_readme = employee_readme.replace("](../DEBUG.md)", "](DEBUG.md)").replace("](EMPLOYEE-DATA-NOTE.md)", "](DATA-AND-SUPPORT.md)")
        (bundle_root / "README.md").write_text(employee_readme, encoding="utf-8")
        shutil.copy2(DATA_NOTE, bundle_root / "DATA-AND-SUPPORT.md")
        shutil.copy2(DEBUG_NOTE, bundle_root / "DEBUG.md")
        shutil.copy2(native_dir / "SHA256SUMS", bundle_root / "SHA256SUMS")
        employee_release_manifest = {
            "format": "fargowork-employee-release-manifest/v1",
            "name": "fargowork-employee",
            "version": client_version,
            "stage": str(_read_json(CLIENT_VERSION_FILE).get("stage") or "local-employee-candidate"),
            "platform": "windows",
            "arch": "x64",
            "mcp_protocol_versions": native_manifest["mcp_protocol_versions"],
            "agent_plugins_spec": native_manifest["agent_plugins_spec"],
            "action_result_contract": native_manifest["action_result_contract"],
            "artifacts": native_manifest["artifacts"],
            "checksums": "SHA256SUMS",
            "service_issuer": "operator-supplied-at-install",
            "server_code_included": False,
            "source_revision_disclosed": False,
        }
        (bundle_root / "release-manifest.json").write_text(
            json.dumps(employee_release_manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

        expected_bundle_files = BUNDLE_FIXED_FILES | {artifact.name for artifact in artifacts}
        actual_bundle_files = {path.name for path in bundle_root.iterdir() if path.is_file()}
        if actual_bundle_files != expected_bundle_files - {"candidate-manifest.json"}:
            raise RuntimeError(f"employee bundle source file set is unexpected: {sorted(actual_bundle_files)}")

        contents = [
            {"name": path.name, "size": path.stat().st_size, "sha256": sha256_file(path)}
            for path in sorted(bundle_root.iterdir(), key=lambda item: item.name)
            if path.is_file()
        ]
        pyinstaller_version = "unknown"
        pyinstaller = shutil.which("pyinstaller")
        if pyinstaller:
            probe = subprocess.run([pyinstaller, "--version"], capture_output=True, text=True, check=False)
            if probe.returncode == 0:
                pyinstaller_version = probe.stdout.strip()
        candidate_manifest = {
            "format": "fargowork-employee-candidate/v1",
            "version": client_version,
            "server_version": server_version,
            "candidate_scope": {
                "platform": "windows-x64",
                "client": "stdio-mcp",
                "installation_targets": ["manual", "codex", "cursor", "workbuddy", "claude-code"],
                "environment": "employee",
                "plugin_name": "fargowork-employee",
            },
            "source": {
                "public_source_tree_sha256": source["sha256"],
                "public_plugin_export_file_count": source["plugin_export_count"],
            },
            "protocol": {
                "employee_bridge": "2025-11-25",
                "server_mcp": "2026-07-28",
                "oauth_client_id": "fargowork-cli",
                "issuer": "operator-supplied-at-install",
                "resource_path": "/mcp",
                "resource_metadata_path": "/.well-known/oauth-protected-resource",
                "loopback_callback": "http://127.0.0.1:37680/oauth/callback",
            },
            "server_code_included": False,
            "form_or_approval_rules_included": False,
            "external_endpoint_configured": False,
            "employee_acceptance": False,
            "public_release_published": False,
            "build_toolchain": {
                "python": platform.python_version(),
                "pyinstaller": pyinstaller_version,
                "byte_for_byte_reproducibility": "not-claimed",
            },
            "bundle_contents": contents,
            "release_manifest_format": employee_release_manifest["format"],
        }
        (bundle_root / "candidate-manifest.json").write_text(
            json.dumps(candidate_manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        bundle_archive = staging / bundle_name
        _zip_tree(bundle_root, bundle_archive)

        archive_hash = sha256_file(bundle_archive)
        candidate_manifest["candidate_archive"] = {
            "name": bundle_name,
            "size": bundle_archive.stat().st_size,
            "sha256": archive_hash,
        }
        final_manifest = output_dir / "candidate-manifest.json"
        final_manifest.write_text(
            json.dumps(candidate_manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        shutil.copy2(bundle_archive, output_dir / bundle_name)
        (output_dir / "SHA256SUMS").write_text(
            f"{archive_hash}  {bundle_name}\n", encoding="utf-8"
        )
    return candidate_manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=("windows",), default="windows")
    parser.add_argument("--arch", choices=("x64",), default="x64")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=ROOT / "dist" / "employee-candidate",
    )
    args = parser.parse_args()
    manifest = build(
        platform_name=args.platform,
        arch=args.arch,
        output_dir=args.output_dir.resolve(),
    )
    print(f"Built local employee candidate: {args.output_dir.resolve()}")
    print(f"Version: {manifest['version']}; scope: Windows x64 business CLI + optional stdio MCP")
    print(f"SHA-256: {manifest['candidate_archive']['sha256']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
