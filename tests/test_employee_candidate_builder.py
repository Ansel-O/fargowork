from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from tools.release import build_employee_candidate as builder


class EmployeeCandidateBuilderTests(unittest.TestCase):
    def test_server_version_comes_from_server_release(self):
        self.assertEqual(
            builder.SERVER_VERSION_FILE,
            builder.ROOT / "server" / "release" / "version.json",
        )

    def test_different_server_version_does_not_block_employee_build(self):
        native_manifest = {
            "mcp_protocol_versions": ["2026-07-28"],
            "agent_plugins_spec": "1.0",
            "action_result_contract": "1.0",
            "artifacts": [],
        }

        def read_version(path: Path):
            if path == builder.CLIENT_VERSION_FILE:
                return {"version": "1.0.0"}
            if path == builder.SERVER_VERSION_FILE:
                return {"version": "7.4.2"}
            raise AssertionError(f"unexpected version file: {path}")

        def fake_native_build(command, **_kwargs):
            if command[-1:] == ["--version"]:
                return SimpleNamespace(returncode=0, stdout="fixture", stderr="")
            native_dir = Path(command[command.index("--output-dir") + 1])
            native_dir.mkdir(parents=True)
            names = [
                "fargowork-agent-plugin-v1.0.0-windows-x64.zip",
                "fargowork-bridge-v1.0.0-windows-x64.zip",
                "fargowork-cli-v1.0.0-windows-x64.zip",
            ]
            for name in names:
                (native_dir / name).write_bytes(b"fixture artifact")
            (native_dir / "SHA256SUMS").write_text("fixture checksums\n", encoding="utf-8")
            return None

        def fake_verify(native_dir: Path, _version: str):
            names = [
                "fargowork-agent-plugin-v1.0.0-windows-x64.zip",
                "fargowork-bridge-v1.0.0-windows-x64.zip",
                "fargowork-cli-v1.0.0-windows-x64.zip",
            ]
            return [native_dir / name for name in names], native_manifest

        with tempfile.TemporaryDirectory() as temporary:
            output_dir = Path(temporary) / "candidate"
            server_version_fixture = Path(temporary) / "server-version.json"
            server_version_fixture.write_text('{"version":"7.4.2"}', encoding="utf-8")
            with (
                patch.object(builder, "SERVER_VERSION_FILE", server_version_fixture),
                patch.object(builder.platform, "system", return_value="Windows"),
                patch.object(builder.platform, "machine", return_value="AMD64"),
                patch.object(builder, "_read_json", side_effect=read_version),
                patch.object(
                    builder,
                    "_source_manifest",
                    return_value={
                        "sha256": "ab" * 32,
                        "plugin_export_count": 4,
                    },
                ),
                patch.object(builder.subprocess, "run", side_effect=fake_native_build),
                patch.object(builder, "_verify_native_artifacts", side_effect=fake_verify),
            ):
                manifest = builder.build(
                    platform_name="windows", arch="x64", output_dir=output_dir
                )

        self.assertEqual(manifest["version"], "1.0.0")
        self.assertEqual(manifest["server_version"], "7.4.2")


if __name__ == "__main__":
    unittest.main()
