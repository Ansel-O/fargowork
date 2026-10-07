"""Build an M4 local release from the public CLI source.

The command intentionally builds only the requested host platform.  A local
Windows run therefore emits real Windows artifacts and does not create fake
Linux binaries.  CI invokes the same builder once per native runner. macOS is
deliberately rejected until the native Security.framework vault boundary is
implemented; no macOS artifact is emitted by this M4 builder.
"""

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
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
CLI_SOURCE = ROOT / "public" / "cli" / "fargowork_cli.py"
PLUGIN_SOURCE = ROOT / "public" / "agent-plugin" / "fargowork"
VERSION_FILE = ROOT / "public" / "release" / "version.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def semver(value: str) -> str:
    import re

    if not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?", value):
        raise ValueError(f"invalid release version: {value}")
    return value


def _zip_file(path: Path, archive: Path, *, member: str) -> None:
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
        info = zipfile.ZipInfo(member, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = 0o100755 << 16
        output.writestr(info, path.read_bytes())


def _zip_tree(root: Path, archive: Path) -> None:
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
        for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
            if not path.is_file():
                continue
            relative = path.relative_to(root).as_posix()
            info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100755 << 16 if path.suffix in {".cmd", ".sh", ".exe"} else 0o100644 << 16
            output.writestr(info, path.read_bytes())


def _build_executable(version: str, platform_name: str, arch: str, staging: Path) -> Path:
    if platform_name == "windows" and arch != "x64":
        raise ValueError("the local Windows builder supports x64 only")
    if not CLI_SOURCE.is_file():
        raise FileNotFoundError(CLI_SOURCE)
    pyinstaller = shutil.which("pyinstaller")
    if not pyinstaller:
        raise RuntimeError("PyInstaller is required for a standalone build; install it in the build environment")
    work = staging / "pyinstaller"
    work.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [
            pyinstaller,
            "--noconfirm",
            "--clean",
            "--onefile",
            "--paths",
            str(CLI_SOURCE.parent),
            "--name",
            "fargowork",
            "--distpath",
            str(work / "dist"),
            "--workpath",
            str(work / "work"),
            "--specpath",
            str(work / "spec"),
            str(CLI_SOURCE),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"PyInstaller failed: {result.stderr[-2000:]}")
    executable = work / "dist" / ("fargowork.exe" if platform_name == "windows" else "fargowork")
    if not executable.is_file():
        raise RuntimeError(f"PyInstaller did not emit {executable}")
    return executable


def build(*, version: str, platform_name: str, arch: str, output_dir: Path) -> dict[str, Any]:
    version = semver(version)
    version_info = json.loads(VERSION_FILE.read_text(encoding="utf-8"))
    protocols = version_info.get("mcp_protocol_versions")
    action_contract = version_info.get("action_result_contract")
    agent_plugins_spec = version_info.get("agent_plugins_spec")
    if not isinstance(protocols, list) or not protocols or any(
        not isinstance(value, str) or not value.strip() for value in protocols
    ):
        raise RuntimeError("mcp_protocol_versions must be a non-empty string list")
    if not isinstance(action_contract, int) or action_contract <= 0:
        raise RuntimeError("action_result_contract must be a positive integer")
    if not isinstance(agent_plugins_spec, str) or not agent_plugins_spec.strip():
        raise RuntimeError("agent_plugins_spec is required")
    host_platform = {"Windows": "windows", "Linux": "linux"}.get(platform.system())
    host_arch = {"AMD64": "x64", "x86_64": "x64", "ARM64": "arm64", "aarch64": "arm64"}.get(platform.machine())
    if platform_name != host_platform or arch != host_arch:
        raise RuntimeError(f"native builder must run on the requested host platform/architecture; host={host_platform}-{host_arch}, requested={platform_name}-{arch}")
    if output_dir.exists() and any(output_dir.iterdir()):
        raise RuntimeError(f"output directory must be empty: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="fargowork-build-") as temp_name:
        staging = Path(temp_name)
        executable = _build_executable(version, platform_name, arch, staging)
        extension = "exe" if platform_name == "windows" else "bin"
        cli_archive = output_dir / f"fargowork-cli-v{version}-{platform_name}-{arch}.zip"
        bridge_archive = output_dir / f"fargowork-bridge-v{version}-{platform_name}-{arch}.zip"
        cli_root = staging / "cli"
        cli_root.mkdir()
        shutil.copy2(executable, cli_root / f"fargowork.{extension}")
        (cli_root / "VERSION").write_text(version + "\n", encoding="utf-8")
        (cli_root / "README.txt").write_text(
            "FargoWork single executable. Use fargowork install, login, doctor, or bridge.\n",
            encoding="utf-8",
        )
        _zip_tree(cli_root, cli_archive)
        bridge_root = staging / "bridge"
        bridge_root.mkdir()
        shutil.copy2(executable, bridge_root / f"fargowork.{extension}")
        (bridge_root / "bridge.txt").write_text(
            "The bridge artifact is the same FargoWork executable invoked as: fargowork bridge\n",
            encoding="utf-8",
        )
        _zip_tree(bridge_root, bridge_archive)

        # The plugin package is built by the existing fail-closed deterministic
        # builder and then staged with the platform executable beside the
        # plugin-relative launcher.  This keeps the checked-in public source
        # text-only while the release package contains the actual binary.
        plugin_builder = ROOT / "tools" / "release" / "build_public_release.py"
        plugin_temp = staging / "plugin"
        subprocess.run(
            [sys.executable, str(plugin_builder), "--version", version, "--output-dir", str(plugin_temp)],
            cwd=ROOT,
            check=True,
        )
        plugin_archive = next(plugin_temp.glob("fargowork-agent-plugin-*.zip"))
        rebuilt_plugin = output_dir / f"fargowork-agent-plugin-v{version}-{platform_name}-{arch}.zip"
        with zipfile.ZipFile(plugin_archive, "r") as source_zip, zipfile.ZipFile(rebuilt_plugin, "w", compression=zipfile.ZIP_DEFLATED) as output_zip:
            binary_member = "fargowork/bin/fargowork.exe" if platform_name == "windows" else "fargowork/bin/fargowork"
            package_manifest = json.loads(source_zip.read("fargowork/PACKAGE-MANIFEST.json").decode("utf-8"))
            package_manifest["files"].append({"path": binary_member.removeprefix("fargowork/"), "size": executable.stat().st_size, "sha256": sha256(executable)})
            package_manifest["files"] = sorted(package_manifest["files"], key=lambda item: item["path"])
            for info in sorted(source_zip.infolist(), key=lambda item: item.filename):
                data = source_zip.read(info.filename)
                if info.filename == "fargowork/PACKAGE-MANIFEST.json":
                    data = (json.dumps(package_manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
                output_zip.writestr(info, data)
            info = zipfile.ZipInfo(binary_member, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100755 << 16
            output_zip.writestr(info, executable.read_bytes())

    artifacts = []
    for path in sorted(output_dir.iterdir(), key=lambda item: item.name):
        if path.name == "SHA256SUMS":
            continue
        artifacts.append({"name": path.name, "size": path.stat().st_size, "sha256": sha256(path)})
    (output_dir / "SHA256SUMS").write_text(
        "".join(f"{item['sha256']}  {item['name']}\n" for item in artifacts),
        encoding="utf-8",
    )
    manifest = {
        "format": "fargowork-release-manifest/v2",
        "name": "fargowork",
        "version": version,
        "tag": f"v{version}",
        "stage": "M4-local-artifacts",
        "mcp_protocol_versions": protocols,
        "agent_plugins_spec": agent_plugins_spec,
        "action_result_contract": action_contract,
        "platform": platform_name,
        "arch": arch,
        "artifacts": artifacts,
        "checksums": "SHA256SUMS",
        "cli": {"status": "emitted", "entrypoint": "fargowork"},
        "bridge": {
            "status": "emitted",
            "entrypoint": "fargowork bridge",
            "transport": "stdio -> modern MCP Streamable HTTP",
            "supported_protocol_versions": protocols,
        },
        "workbuddy": {"status": "official-codebuddy-user-registration-ui-trust-required"},
        "release": {"remote": "not-published", "signing": "not-configured", "attestation": "CI-only"},
    }
    (output_dir / "release-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version")
    parser.add_argument("--platform", choices=("windows", "linux"), default=None)
    parser.add_argument("--arch", choices=("x64", "arm64"), default="x64")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist" / "release" / "local")
    args = parser.parse_args()
    version = args.version or str(json.loads(VERSION_FILE.read_text(encoding="utf-8"))["version"])
    if args.platform:
        platform_name = args.platform
    else:
        platform_name = {"Windows": "windows", "Linux": "linux"}.get(platform.system())
        if platform_name is None:
            raise RuntimeError("this M4 builder supports Windows/Linux only; macOS requires native Security.framework vault support")
    manifest = build(version=version, platform_name=platform_name, arch=args.arch, output_dir=args.output_dir.resolve())
    print(f"Built local FargoWork release: {args.output_dir.resolve()}")
    print(f"Platform: {manifest['platform']}-{manifest['arch']}")
    print(f"Artifacts: {len(manifest['artifacts'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
