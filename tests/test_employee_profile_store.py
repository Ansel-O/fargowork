import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "public" / "cli" / "employee_profile.py"
spec = importlib.util.spec_from_file_location("fargowork_employee_profile_test", MODULE_PATH)
profile = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(profile)


class EmployeeProfileStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name) / "employee"
        self.identity = {"corp_id": "fixture-corp", "userid": "fixture-user"}
        self.other_user = {"corp_id": "fixture-corp", "userid": "fixture-user-b"}
        self.other_corp = {"corp_id": "fixture-corp-b", "userid": "fixture-user"}
        self.store = profile.ProfileStore(self.home, "1.2.0")

    def document(self, result):
        return Path(result["markdown_path"])

    def metadata(self, result):
        return self.document(result).with_name("metadata.json")

    def assert_code(self, expected, call):
        with self.assertRaises(profile.ProfileError) as caught:
            call()
        self.assertEqual(expected, caught.exception.code)
        self.assertNotIn("fixture-user", str(caught.exception))
        self.assertNotIn("fixture-corp", str(caught.exception))

    def test_first_use_creates_editable_template_without_raw_identity(self):
        result = self.store.open_for_verified_identity(self.identity)
        document = self.document(result)
        self.assertEqual(profile.SCHEMA_VERSION, result["schema_version"])
        self.assertFalse(result["reset_prompt_pending"])
        self.assertEqual(profile.DEFAULT_PREFERENCES, result["preferences"])
        self.assertRegex(result["profile_id"], r"^[a-f0-9]{64}$")
        self.assertEqual(self.home / "profiles" / result["profile_id"] / "preferences.md", document)
        self.assertEqual(profile.DEFAULT_MARKDOWN, document.read_text(encoding="utf-8"))
        raw = self.metadata(result).read_text(encoding="utf-8")
        self.assertNotIn("fixture-user", raw)
        self.assertNotIn("fixture-corp", raw)
        self.assertNotIn("userid", raw)
        self.assertNotIn("corp_id", raw)
        self.assertNotIn("markdown_path", raw)
        self.assertNotIn("reviewed_client_versions", result)

    def test_company_and_employee_are_both_part_of_identity(self):
        first = self.store.update_preferences(self.identity, {"language": "en"})
        second = self.store.open_for_verified_identity(self.other_user)
        third = self.store.open_for_verified_identity(self.other_corp)
        self.assertEqual(3, len({row["profile_id"] for row in (first, second, third)}))
        self.assertEqual("zh-CN", second["preferences"]["language"])
        self.assertEqual("zh-CN", third["preferences"]["language"])
        self.assertEqual("en", self.store.open_for_verified_identity(self.identity)["preferences"]["language"])

    def test_compound_key_cannot_collide_from_simple_concatenation(self):
        first = self.store.open_for_verified_identity({"corp_id": "ab", "userid": "c"})
        second = self.store.open_for_verified_identity({"corp_id": "a", "userid": "bc"})
        self.assertNotEqual(first["profile_id"], second["profile_id"])

    def test_unicode_home_and_identity_are_supported_without_path_identifiers(self):
        home = Path(self.temporary.name) / "员工资料 空格"
        store = profile.ProfileStore(home, "1.2.0")
        result = store.open_for_verified_identity({"corp_id": "企业测试", "userid": "员工测试"})
        self.assertEqual(home / "profiles" / result["profile_id"] / "preferences.md", self.document(result))
        self.assertEqual(profile.DEFAULT_MARKDOWN, self.document(result).read_text(encoding="utf-8"))
        self.assertNotIn("企业测试", self.metadata(result).read_text(encoding="utf-8"))
        self.assertNotIn("员工测试", self.metadata(result).read_text(encoding="utf-8"))

    def test_verified_identity_may_include_server_display_fields(self):
        result = self.store.open_for_verified_identity({**self.identity, "name": "Fixture", "scope": "fargowork:mcp"})
        self.assertNotIn("name", result)
        self.assertEqual(result["profile_id"], self.store.open_for_verified_identity(self.identity)["profile_id"])

    def test_user_document_and_preferences_survive_upgrade(self):
        first = self.store.update_preferences(self.identity, {"language": "en", "response_style": "detailed"})
        document = self.document(first)
        document.write_text("# 我的习惯\n优先询问出差目的；常用币种只供建议。\n", encoding="utf-8")
        before = document.read_bytes()
        upgraded = profile.ProfileStore(self.home, "1.3.0")
        result = upgraded.open_for_verified_identity(self.identity)
        self.assertTrue(result["reset_prompt_pending"])
        self.assertEqual(first["preferences"], result["preferences"])
        self.assertEqual(first["created_at"], result["created_at"])
        self.assertEqual(before, document.read_bytes())
        metadata_before = self.metadata(result).read_bytes()
        self.assertTrue(upgraded.open_for_verified_identity(self.identity)["reset_prompt_pending"])
        self.assertEqual(metadata_before, self.metadata(result).read_bytes())
        kept = upgraded.decide_reset(self.identity, reset=False)
        self.assertFalse(kept["reset_prompt_pending"])
        self.assertEqual(before, document.read_bytes())
        self.assertEqual(first["preferences"], kept["preferences"])
        self.assertFalse(upgraded.open_for_verified_identity(self.identity)["reset_prompt_pending"])

    def test_review_choice_is_remembered_per_client_version(self):
        self.store.open_for_verified_identity(self.identity)
        new = profile.ProfileStore(self.home, "1.3.0")
        self.assertTrue(new.open_for_verified_identity(self.identity)["reset_prompt_pending"])
        new.decide_reset(self.identity, reset=False)
        self.assertFalse(self.store.open_for_verified_identity(self.identity)["reset_prompt_pending"])
        self.assertFalse(new.open_for_verified_identity(self.identity)["reset_prompt_pending"])
        self.assertTrue(profile.ProfileStore(self.home, "1.4.0").open_for_verified_identity(self.identity)["reset_prompt_pending"])

    def test_explicit_reset_touches_only_current_identity(self):
        first = self.store.update_preferences(self.identity, {"language": "en"})
        second = self.store.update_preferences(self.other_user, {"response_style": "detailed"})
        self.document(first).write_text("My own custom preferences", encoding="utf-8")
        self.document(second).write_text("Other employee custom preferences", encoding="utf-8")
        other_metadata = self.metadata(second).read_bytes()
        other_document = self.document(second).read_bytes()
        new = profile.ProfileStore(self.home, "1.3.0")
        result = new.decide_reset(self.identity, reset=True)
        self.assertFalse(result["reset_prompt_pending"])
        self.assertEqual(profile.DEFAULT_PREFERENCES, result["preferences"])
        self.assertEqual(profile.DEFAULT_MARKDOWN, self.document(result).read_text(encoding="utf-8"))
        self.assertEqual(other_metadata, self.metadata(second).read_bytes())
        self.assertEqual(other_document, self.document(second).read_bytes())

    def test_display_updates_preserve_document_and_prompt(self):
        initial = self.store.open_for_verified_identity(self.identity)
        self.document(initial).write_text("Personal editable text", encoding="utf-8")
        before = self.document(initial).read_bytes()
        new = profile.ProfileStore(self.home, "1.3.0")
        result = new.update_preferences(self.identity, {"response_style": "balanced"})
        self.assertEqual("balanced", result["preferences"]["response_style"])
        self.assertEqual("zh-CN", result["preferences"]["language"])
        self.assertTrue(result["reset_prompt_pending"])
        self.assertEqual(before, self.document(result).read_bytes())

    def test_bad_identity_is_rejected_without_creating_data(self):
        for identity in (None, {}, {"userid": "fixture-user"}, {"corp_id": "fixture-corp"}, {"corp_id": "", "userid": "x"}, {"corp_id": " x", "userid": "y"}, {"corp_id": "x", "userid": 1}, {"corp_id": "x", "userid": "a\nb"}):
            with self.subTest(identity=identity):
                self.assert_code("profile_identity_invalid", lambda: self.store.open_for_verified_identity(identity))
        self.assertFalse(self.home.exists())

    def test_arbitrary_preferences_and_non_boolean_reset_are_rejected(self):
        for prefs in ({"roles": ["MCP_allow"]}, {"userid": "someone"}, {"amount": 100}, {"language": "xx"}, {"response_style": True}, {"notes": "opaque content"}, []):
            with self.subTest(prefs=prefs):
                self.assert_code("profile_preferences_invalid", lambda: self.store.update_preferences(self.identity, prefs))
        for reset in (0, 1, "false", None):
            with self.subTest(reset=reset):
                self.assert_code("profile_reset_invalid", lambda: self.store.decide_reset(self.identity, reset))
        self.assertFalse(self.home.exists())

    def test_bad_version_is_rejected(self):
        for version in (None, "", "../new", "1.2.0\n", "x" * 65):
            with self.subTest(version=version):
                self.assert_code("profile_version_invalid", lambda: profile.ProfileStore(self.home, version))

    def test_invalid_home_cannot_fall_back_to_the_working_directory(self):
        for home in (None, "", " ", b"folder", "folder\x00suffix"):
            with self.subTest(home=home):
                self.assert_code("profile_path_invalid", lambda: profile.ProfileStore(home, "1.2.0"))

    def test_return_value_cannot_mutate_saved_preferences(self):
        result = self.store.open_for_verified_identity(self.identity)
        result["preferences"]["language"] = "en"
        self.assertEqual("zh-CN", self.store.open_for_verified_identity(self.identity)["preferences"]["language"])

    def test_corrupt_or_foreign_metadata_is_never_overwritten(self):
        result = self.store.open_for_verified_identity(self.identity)
        metadata = self.metadata(result)
        original = json.loads(metadata.read_text(encoding="utf-8"))
        variants = (
            (b"not json", "profile_data_invalid"),
            (b'{"schema_version":1,"schema_version":1}', "profile_data_invalid"),
            (json.dumps({**original, "schema_version": 2}).encode(), "profile_schema_unsupported"),
            (json.dumps({**original, "profile_id": "0" * 64}).encode(), "profile_identity_mismatch"),
            (json.dumps({**original, "roles": ["MCP_allow"]}).encode(), "profile_data_invalid"),
            (json.dumps({**original, "reset_prompt_pending": 1}).encode(), "profile_data_invalid"),
            (json.dumps({**original, "reset_prompt_pending": True}).encode(), "profile_data_invalid"),
            (json.dumps({**original, "client_version": "../wrong"}).encode(), "profile_data_invalid"),
            (json.dumps({**original, "preferences": {"language": "xx", "response_style": "concise"}}).encode(), "profile_data_invalid"),
            (json.dumps({**original, "reviewed_client_versions": ["1.2.0", "1.2.0"]}).encode(), "profile_data_invalid"),
            (json.dumps({**original, "created_at": "wrong"}).encode(), "profile_data_invalid"),
            (b"x" * (profile.MAX_PROFILE_BYTES + 1), "profile_data_invalid"),
        )
        for raw, code in variants:
            with self.subTest(code=code, length=len(raw)):
                metadata.write_bytes(raw)
                self.assert_code(code, lambda: self.store.open_for_verified_identity(self.identity))
                self.assertEqual(raw, metadata.read_bytes())

    def test_missing_half_of_profile_is_preserved_for_recovery(self):
        result = self.store.open_for_verified_identity(self.identity)
        document = self.document(result)
        metadata = self.metadata(result)
        raw = document.read_bytes()
        metadata.unlink()
        self.assert_code("profile_incomplete", lambda: self.store.open_for_verified_identity(self.identity))
        self.assertEqual(raw, document.read_bytes())
        self.assertFalse(metadata.exists())

    def test_missing_document_does_not_clear_metadata_or_credentials(self):
        result = self.store.open_for_verified_identity(self.identity)
        metadata = self.metadata(result)
        before = metadata.read_bytes()
        vault = self.home / "unrelated-vault.bin"
        vault.write_bytes(b"fixture-private-storage-not-a-token")
        self.document(result).unlink()
        self.assert_code("profile_incomplete", lambda: self.store.decide_reset(self.identity, True))
        self.assertEqual(before, metadata.read_bytes())
        self.assertEqual(b"fixture-private-storage-not-a-token", vault.read_bytes())

    def test_invalid_or_oversized_document_is_never_overwritten(self):
        result = self.store.open_for_verified_identity(self.identity)
        document = self.document(result)
        for content in (b"\xff", b"text\x00hidden", b"x" * (profile.MAX_PROFILE_BYTES + 1)):
            with self.subTest(length=len(content)):
                document.write_bytes(content)
                self.assert_code("profile_document_invalid", lambda: self.store.open_for_verified_identity(self.identity))
                self.assert_code("profile_document_invalid", lambda: self.store.decide_reset(self.identity, True))
                self.assertEqual(content, document.read_bytes())

    def test_utf8_bom_and_empty_user_documents_are_supported(self):
        result = self.store.open_for_verified_identity(self.identity)
        document = self.document(result)
        for content in (b"", b"\xef\xbb\xbf" + "中文偏好".encode("utf-8")):
            with self.subTest(content=content):
                document.write_bytes(content)
                self.store.open_for_verified_identity(self.identity)
                self.assertEqual(content, document.read_bytes())

    def test_atomic_metadata_write_failure_preserves_previous_data(self):
        result = self.store.open_for_verified_identity(self.identity)
        metadata = self.metadata(result)
        before = metadata.read_bytes()
        with patch.object(profile.os, "replace", side_effect=PermissionError("fixture failure")):
            self.assert_code("profile_storage_unavailable", lambda: self.store.update_preferences(self.identity, {"language": "en"}))
        self.assertEqual(before, metadata.read_bytes())
        self.assertEqual([], list(metadata.parent.glob("*.tmp")))

    def test_hardlinked_document_metadata_and_lock_are_rejected(self):
        result = self.store.open_for_verified_identity(self.identity)
        for path in (self.document(result), self.metadata(result), self.home / "profiles" / f"{result['profile_id']}.lock"):
            with self.subTest(path=path.name):
                original = path.read_bytes()
                external = Path(self.temporary.name) / f"external-{path.name}"
                external.write_bytes(original)
                path.unlink()
                os.link(external, path)
                self.assert_code("profile_path_unsafe", lambda: self.store.open_for_verified_identity(self.identity))
                self.assertEqual(original, external.read_bytes())
                path.unlink()
                path.write_bytes(original)

    def _directory_link(self, target, link):
        try:
            os.symlink(target, link, target_is_directory=True)
            self.addCleanup(lambda: link.unlink(missing_ok=True))
        except OSError:
            if os.name != "nt":
                raise
            completed = subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(target)], stdin=subprocess.DEVNULL, capture_output=True, timeout=10)
            if completed.returncode:
                self.skipTest("Directory links are unavailable on this test machine")
            self.addCleanup(lambda: os.rmdir(link) if link.exists() else None)

    def test_linked_profile_root_cannot_write_outside_home(self):
        self.home.mkdir()
        outside = Path(self.temporary.name) / "outside"
        outside.mkdir()
        self._directory_link(outside, self.home / "profiles")
        self.assert_code("profile_path_unsafe", lambda: self.store.open_for_verified_identity(self.identity))
        self.assertEqual([], list(outside.iterdir()))

    def test_linked_identity_folder_cannot_read_another_account(self):
        first = self.store.open_for_verified_identity(self.identity)
        target = self.document(first).parent
        other_key = profile._identity_key(self.other_user)
        self._directory_link(target, self.home / "profiles" / other_key)
        before = self.metadata(first).read_bytes()
        self.assert_code("profile_path_unsafe", lambda: self.store.open_for_verified_identity(self.other_user))
        self.assertEqual(before, self.metadata(first).read_bytes())

    def test_symlinked_document_cannot_read_external_file(self):
        result = self.store.open_for_verified_identity(self.identity)
        document = self.document(result)
        external = Path(self.temporary.name) / "external.md"
        external.write_text("Must remain outside the profile", encoding="utf-8")
        document.unlink()
        try:
            os.symlink(external, document)
        except OSError:
            self.skipTest("File symlinks are unavailable on this test machine")
        self.assert_code("profile_path_unsafe", lambda: self.store.open_for_verified_identity(self.identity))
        self.assertEqual("Must remain outside the profile", external.read_text(encoding="utf-8"))

    def test_threads_can_create_one_profile_without_overwriting_preferences(self):
        with ThreadPoolExecutor(max_workers=8) as executor:
            rows = list(executor.map(lambda _: self.store.open_for_verified_identity(self.identity), range(20)))
        self.assertEqual(1, len({row["profile_id"] for row in rows}))
        self.assertEqual(1, len({row["created_at"] for row in rows}))
        self.assertEqual(profile.DEFAULT_MARKDOWN, self.document(rows[0]).read_text(encoding="utf-8"))

    def test_processes_merge_independent_preference_updates(self):
        self.store.open_for_verified_identity(self.identity)
        script = """
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('child_profile', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
store = module.ProfileStore(sys.argv[2], '1.2.0')
for _ in range(15):
    store.update_preferences({'corp_id':'fixture-corp','userid':'fixture-user'}, json.loads(sys.argv[3]))
print('ok')
"""
        children = [subprocess.Popen([sys.executable, "-B", "-c", script, str(MODULE_PATH), str(self.home), json.dumps(prefs)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for prefs in ({"language": "en"}, {"response_style": "detailed"})]
        try:
            for child in children:
                stdout, stderr = child.communicate(timeout=30)
                self.assertEqual(0, child.returncode, stderr)
                self.assertEqual("ok", stdout.strip())
        finally:
            for child in children:
                if child.poll() is None:
                    child.kill()
                    child.communicate()
        result = self.store.open_for_verified_identity(self.identity)
        self.assertEqual({"language": "en", "response_style": "detailed"}, result["preferences"])

    def test_profile_operations_do_not_use_network(self):
        with patch("socket.socket", side_effect=AssertionError("network forbidden")):
            self.store.open_for_verified_identity(self.identity)
            self.store.update_preferences(self.identity, {"language": "en"})
            self.store.decide_reset(self.identity, False)

    def test_lock_timeout_keeps_the_profile_intact(self):
        result = self.store.open_for_verified_identity(self.identity)
        before = self.metadata(result).read_bytes()
        lock_path = self.home / "profiles" / f"{result['profile_id']}.lock"
        with profile._profile_lock(lock_path):
            with patch.object(profile, "LOCK_TIMEOUT_SECONDS", 0.01):
                self.assert_code("profile_busy", lambda: self.store.open_for_verified_identity(self.identity))
        self.assertEqual(before, self.metadata(result).read_bytes())
        self.assertEqual(result["profile_id"], self.store.open_for_verified_identity(self.identity)["profile_id"])

    def test_full_version_history_rejects_reset_without_erasing_document(self):
        result = self.store.open_for_verified_identity(self.identity)
        document = self.document(result)
        document.write_text("Keep my custom preferences", encoding="utf-8")
        new = profile.ProfileStore(self.home, "1.3.0")
        with patch.object(profile, "MAX_REVIEWED_VERSIONS", 1):
            pending = new.open_for_verified_identity(self.identity)
            self.assertTrue(pending["reset_prompt_pending"])
            before = self.metadata(pending).read_bytes()
            self.assert_code("profile_history_limit", lambda: new.decide_reset(self.identity, True))
            self.assertEqual(before, self.metadata(pending).read_bytes())
            self.assertEqual("Keep my custom preferences", document.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
