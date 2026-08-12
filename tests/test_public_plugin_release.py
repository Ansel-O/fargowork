import importlib.util
import json
import os
import shutil
import tempfile
import unittest
import zipfile
from pathlib import Path, PurePosixPath
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = REPO_ROOT / "public" / "agent-plugin" / "fargowork"
EXPORT_SPEC = REPO_ROOT / "public" / "release" / "public-export.json"
VERSION_FILE = REPO_ROOT / "public" / "release" / "version.json"
BUILDER_PATH = REPO_ROOT / "tools" / "release" / "build_public_release.py"


def load_builder():
    spec = importlib.util.spec_from_file_location("build_public_release", BUILDER_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


class PublicPluginReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.builder = load_builder()

    def test_standard_manifest_mcp_and_skill_contract(self):
        spec = self.builder._load_export_spec(REPO_ROOT, EXPORT_SPEC)
        payloads = self.builder.validate_export_source(spec)
        plugin = self.builder.validate_plugin_contract(payloads)

        self.assertEqual(plugin["$schema"], self.builder.PLUGIN_SCHEMA)
        self.assertEqual(plugin["name"], "fargowork")
        self.assertEqual(plugin["version"], "0.5.0-rc.4")
        self.assertEqual(plugin["license"], "Apache-2.0")
        mcp = json.loads((SOURCE_ROOT / "mcp.json").read_text(encoding="utf-8"))
        self.assertEqual(mcp["$schema"], self.builder.MCP_SCHEMA)
        server = mcp["mcpServers"]["fargowork"]
        self.assertEqual(server["type"], "stdio")
        self.assertEqual(server["command"], "./bin/fargowork.cmd")
        self.assertEqual(server["args"], ["bridge"])
        self.assertEqual(server["cwd"], "${PLUGIN_ROOT}")

    def test_build_injects_version_and_verifies_checksum(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir) / "release"
            manifest = self.builder.build_release(
                repo_root=REPO_ROOT,
                export_spec_path=EXPORT_SPEC,
                version_path=VERSION_FILE,
                output_dir=output_dir,
                version="0.4.0-rc.1",
            )
            artifact = output_dir / manifest["plugin"]["artifact"]
            checksums = output_dir / "SHA256SUMS"
            self.builder.verify_checksums(checksums, output_dir)
            with zipfile.ZipFile(artifact) as archive:
                names = set(archive.namelist())
                plugin = json.loads(archive.read("fargowork/plugin.json"))
                package_manifest = json.loads(archive.read("fargowork/PACKAGE-MANIFEST.json"))

        self.assertEqual(plugin["version"], "0.4.0-rc.1")
        self.assertEqual(package_manifest["version"], "0.4.0-rc.1")
        self.assertEqual(package_manifest["mcp_protocol_versions"], ["2026-07-28"])
        self.assertEqual(package_manifest["agent_plugins_spec"], "1.0.0")
        self.assertEqual(package_manifest["action_result_contract"], 1)
        self.assertEqual(manifest["mcp_protocol_versions"], ["2026-07-28"])
        self.assertEqual(manifest["action_result_contract"], 1)
        self.assertEqual(
            manifest["server_endpoint"]["template"],
            "https://fargowork.ansel.vip/mcp",
        )
        self.assertEqual(manifest["server_endpoint"]["status"], "office-pilot")
        self.assertIn("fargowork/skills/fargowork/SKILL.md", names)
        self.assertNotIn("services/", "\n".join(names))
        self.assertEqual(manifest["reserved_artifacts"][0]["status"], "emitted-by-m4-native-builder")

    def test_same_source_and_version_are_byte_reproducible(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            first = Path(temp_dir) / "first"
            second = Path(temp_dir) / "second"
            self.builder.build_release(
                repo_root=REPO_ROOT,
                export_spec_path=EXPORT_SPEC,
                version_path=VERSION_FILE,
                output_dir=first,
                version="0.4.0",
            )
            self.builder.build_release(
                repo_root=REPO_ROOT,
                export_spec_path=EXPORT_SPEC,
                version_path=VERSION_FILE,
                output_dir=second,
                version="0.4.0",
            )
            first_files = sorted(path.name for path in first.iterdir())
            second_files = sorted(path.name for path in second.iterdir())
            self.assertEqual(first_files, second_files)
            for name in first_files:
                self.assertEqual((first / name).read_bytes(), (second / name).read_bytes(), name)

    def test_checksum_tampering_and_bad_format_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir) / "release"
            self.builder.build_release(
                repo_root=REPO_ROOT,
                export_spec_path=EXPORT_SPEC,
                version_path=VERSION_FILE,
                output_dir=output_dir,
                version="0.4.0",
            )
            artifact = next(output_dir.glob("*.zip"))
            artifact.write_bytes(artifact.read_bytes() + b"tampered")
            with self.assertRaises(self.builder.ReleaseGuardError):
                self.builder.verify_checksums(output_dir / "SHA256SUMS", output_dir)
            (output_dir / "SHA256SUMS").write_text("not-a-checksum\n", encoding="utf-8")
            with self.assertRaises(self.builder.ReleaseGuardError):
                self.builder.verify_checksums(output_dir / "SHA256SUMS", output_dir)

    def _copy_export(self):
        temp = tempfile.TemporaryDirectory()
        root = Path(temp.name)
        source = root / "public" / "agent-plugin" / "fargowork"
        shutil.copytree(SOURCE_ROOT, source, symlinks=True)
        release = root / "public" / "release"
        release.mkdir(parents=True)
        spec_data = json.loads(EXPORT_SPEC.read_text(encoding="utf-8"))
        spec_data["source_root"] = "public/agent-plugin/fargowork"
        (release / "public-export.json").write_text(
            json.dumps(spec_data, indent=2), encoding="utf-8"
        )
        shutil.copy2(VERSION_FILE, release / "version.json")
        return temp, root, source, release / "public-export.json"

    def _spec_with_file(self, root, spec_path, relative_path):
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
        spec["files"].append(relative_path)
        spec_path.write_text(json.dumps(spec, indent=2), encoding="utf-8")
        return self.builder._load_export_spec(root, spec_path)

    def test_missing_file_and_path_traversal_are_rejected(self):
        temp, root, _source, spec_path = self._copy_export()
        try:
            spec = self._spec_with_file(root, spec_path, "missing.txt")
            with self.assertRaises(self.builder.ReleaseGuardError):
                self.builder.validate_export_source(spec)
            spec = json.loads(spec_path.read_text(encoding="utf-8"))
            spec["files"].append("../escape.txt")
            spec_path.write_text(json.dumps(spec), encoding="utf-8")
            with self.assertRaises(self.builder.ReleaseGuardError):
                self.builder._load_export_spec(root, spec_path)
        finally:
            temp.cleanup()

    def test_secret_private_path_and_production_url_are_rejected(self):
        cases = (
            ("notes.txt", "client_secret: 'not-a-real-secret-value'", "secret-like"),
            ("server/config.txt", "public placeholder", "denylisted"),
            ("endpoint.txt", "https://prod.fargowork.example/mcp", "URL"),
        )
        for relative, content, _label in cases:
            with self.subTest(relative=relative):
                temp, root, source, spec_path = self._copy_export()
                try:
                    path = source / Path(*relative.split("/"))
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(content, encoding="utf-8")
                    spec = self._spec_with_file(root, spec_path, relative)
                    with self.assertRaises(self.builder.ReleaseGuardError):
                        self.builder.validate_export_source(spec)
                finally:
                    temp.cleanup()

    def test_symlink_is_rejected_when_platform_allows_symlink_creation(self):
        temp, root, source, spec_path = self._copy_export()
        try:
            link = source / "link.txt"
            try:
                link.symlink_to(source / "plugin.json")
            except (OSError, NotImplementedError) as exc:
                # Windows runners without symlink privilege still exercise the
                # same fail-closed branch by simulating a reparse-point hit.
                link.write_text("not packaged", encoding="utf-8")
                spec = self._spec_with_file(root, spec_path, "link.txt")
                with patch.object(
                    self.builder,
                    "_is_reparse_or_symlink",
                    side_effect=lambda path: Path(path).name == "link.txt",
                ):
                    with self.assertRaises(self.builder.ReleaseGuardError):
                        self.builder.validate_export_source(spec)
                return
            spec = self._spec_with_file(root, spec_path, "link.txt")
            with self.assertRaises(self.builder.ReleaseGuardError):
                self.builder.validate_export_source(spec)
        finally:
            temp.cleanup()

    def test_skill_frontmatter_accepts_windows_crlf_checkout(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            skill_dir = Path(temp_dir) / "fargowork"
            skill_dir.mkdir()
            source = (SOURCE_ROOT / "skills" / "fargowork" / "SKILL.md").read_text(
                encoding="utf-8"
            )
            (skill_dir / "SKILL.md").write_bytes(
                source.replace("\r\n", "\n").replace("\n", "\r\n").encode("utf-8")
            )
            self.builder._validate_skill(skill_dir, PurePosixPath("skills/fargowork"))

    def test_skill_payload_accepts_windows_crlf_checkout(self):
        source = (SOURCE_ROOT / "skills" / "fargowork" / "SKILL.md").read_text(
            encoding="utf-8"
        )
        payload = source.replace("\r\n", "\n").replace("\n", "\r\n").encode("utf-8")
        self.builder._validate_skill_payload(
            payload,
            PurePosixPath("skills/fargowork"),
        )

    def test_release_workflow_is_tagged_pinned_and_server_free(self):
        workflow = (REPO_ROOT / ".github" / "workflows" / "release.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn('tags:', workflow)
        self.assertIn('"v*.*.*"', workflow)
        self.assertIn("actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d", workflow)
        self.assertIn("id-token: write", workflow)
        self.assertIn("attestations: write", workflow)
        self.assertIn("artifact-metadata: write", workflow)
        self.assertIn("contents: write", workflow)
        self.assertIn("--draft", workflow)
        self.assertIn('--repo "${GITHUB_REPOSITORY}"', workflow)
        self.assertNotIn("services/", workflow)
        self.assertNotIn("FARGOWORK_INTERNAL_AUTH_KEY", workflow)


if __name__ == "__main__":
    unittest.main()
