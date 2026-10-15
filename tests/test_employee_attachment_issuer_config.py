"""Controlled configuration separates business and attachment authorization origins.

All identities, addresses and credential markers are synthetic. No OAuth,
network requests or OS credential reads are performed by these tests.
"""
from dataclasses import replace
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "employee_attachment_issuer_config_fixture", ROOT / "public/cli/fargowork_cli.py"
)
cli = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = cli
SPEC.loader.exec_module(cli)

BUSINESS = "http://127.0.0.1:8080"
ATTACHMENT_AUTH = "https://auth.example.invalid"
ATTACHMENT_API = "https://attachments.example.invalid"


class AttachmentIssuerConfigTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="fargowork-issuer-config-")
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name) / "employee"
        self.home_patch = patch.object(cli, "_config_home", return_value=self.home)
        self.plugin_patch = patch.object(cli, "_plugin_home", return_value=self.home / "plugin")
        self.home_patch.start()
        self.plugin_patch.start()
        self.addCleanup(self.home_patch.stop)
        self.addCleanup(self.plugin_patch.stop)

    def config(self, **overrides):
        values = dict(home=self.home, issuer=BUSINESS, resource=BUSINESS + "/mcp",
                      resource_metadata_uri=BUSINESS + "/.well-known/oauth-protected-resource",
                      plugin_dir=self.home / "plugin", attachments_url=ATTACHMENT_API)
        values.update(overrides)
        return cli.Config(**values)

    def write_config(self, **overrides):
        self.home.mkdir(parents=True, exist_ok=True)
        values = dict(environment="employee", issuer=BUSINESS)
        values.update(overrides)
        (self.home / "config.json").write_text(json.dumps(values), encoding="utf-8")

    def test_old_and_empty_config_inherit_the_business_issuer(self):
        for fields in ({}, {"attachments_issuer": ""}, {"attachments_issuer": None}):
            with self.subTest(fields=fields):
                self.write_config(**fields)
                config = cli.Config.load()
                self.assertEqual(config.attachments_issuer, "")
                self.assertEqual(config.effective_attachments_issuer, BUSINESS)
                config.save()
                self.assertEqual(cli.Config.load().effective_attachments_issuer, BUSINESS)
        empty = cli.Config(home=self.home)
        self.assertEqual(empty.effective_attachments_issuer, "")

    def test_saved_cloud_attachment_issuer_preserves_local_business_endpoints(self):
        config = self.config(attachments_issuer=ATTACHMENT_AUTH + "/")
        config.save()
        loaded = cli.Config.load()
        self.assertEqual(loaded.issuer, BUSINESS)
        self.assertEqual(loaded.resource, BUSINESS + "/mcp")
        self.assertEqual(loaded.resource_metadata_uri, BUSINESS + "/.well-known/oauth-protected-resource")
        self.assertEqual(loaded.attachments_url, ATTACHMENT_API)
        self.assertEqual(loaded.attachments_issuer, ATTACHMENT_AUTH)
        self.assertEqual(loaded.effective_attachments_issuer, ATTACHMENT_AUTH)

    def test_new_employee_config_uploads_to_company_cloud_with_distinct_native_credentials(self):
        config = cli.Config(home=self.home, issuer="https://fargowork.fargowealthapp.com")

        class NoNetworkSession:
            def __init__(self, selected_config):
                self.config = selected_config

        with patch.object(cli, "TokenSession", NoNetworkSession):
            client = cli.employee_attachments.AttachmentClient(cli, config)
        self.assertEqual(client.service, "https://attachments.fargowealthapp.com")
        self.assertEqual(client.native.config.issuer, config.issuer)
        self.assertEqual(client.native.config.resource, client.service)
        self.assertEqual(client.native.config.client_id, "fargowork-attachments-native")
        self.assertNotEqual(client.native.config.secure_vault().vault_filename, config.secure_vault().vault_filename)

    def test_actual_attachment_client_uses_independent_authorization_and_vault(self):
        config = self.config(attachments_issuer=ATTACHMENT_AUTH)

        class NoNetworkSession:
            def __init__(self, selected_config):
                self.config = selected_config

        with patch.object(cli, "TokenSession", NoNetworkSession):
            client = cli.employee_attachments.AttachmentClient(cli, config)
        native = client.native.config
        self.assertIs(client.business.config, config)
        self.assertEqual(client.business.config.issuer, BUSINESS)
        self.assertEqual(native.issuer, ATTACHMENT_AUTH)
        self.assertEqual(native.resource, ATTACHMENT_API)
        self.assertEqual(native.resource_metadata_uri, ATTACHMENT_API + "/.well-known/oauth-protected-resource")
        self.assertEqual(native.client_id, "fargowork-attachments-native")
        self.assertEqual(native.redirect_uri, "http://127.0.0.1:37681/oauth/callback")
        self.assertEqual(native.scope, "fargowork:attachments")
        self.assertEqual(config.client_id, "fargowork-cli")
        self.assertEqual(config.scope, "fargowork:mcp")
        self.assertEqual(config.redirect_uri, "http://127.0.0.1:37680/oauth/callback")
        self.assertNotEqual(native.secure_vault().vault_filename, config.secure_vault().vault_filename)
        other_attachment_auth = replace(native, issuer="https://other-auth.example.invalid")
        self.assertNotEqual(native.secure_vault().vault_filename, other_attachment_auth.secure_vault().vault_filename)

    def test_changing_attachment_issuer_does_not_move_business_credentials(self):
        inherited = self.config()
        explicit = replace(inherited, attachments_issuer=ATTACHMENT_AUTH)
        self.assertEqual(inherited.credential_fingerprint, explicit.credential_fingerprint)
        self.assertEqual(inherited.secure_vault().vault_filename, explicit.secure_vault().vault_filename)

    def test_issuer_is_saved_configuration_only_and_has_no_environment_override(self):
        self.write_config(attachments_issuer=ATTACHMENT_AUTH)
        with patch.dict(os.environ, {"FARGOWORK_ATTACHMENTS_ISSUER": "https://override.example.invalid"}):
            self.assertEqual(cli.Config.load().effective_attachments_issuer, ATTACHMENT_AUTH)
        self.assertNotIn("--attachments-issuer", cli._build_parser().format_help())

    def test_invalid_attachment_issuers_fail_before_config_is_saved(self):
        invalid = (
            "http://auth.example.invalid", "http://192.0.2.1", "ftp://auth.example.invalid",
            "https://user@auth.example.invalid", "https://user:password@auth.example.invalid",
            "https://@auth.example.invalid", "https://auth.example.invalid/path",
            "https://auth.example.invalid?x=1", "https://auth.example.invalid?",
            "https://auth.example.invalid#fragment", "https://auth.example.invalid#",
            " https://auth.example.invalid", "https://auth.example.invalid\n",
            "https://auth.example.invalid\x00", "https://auth.example.invalid:bad",
            "https://auth.example.invalid:0", "https://auth.example.invalid:65536",
            "https://auth.example.invalid:", "https://[::1", "https://auth\\example.invalid",
            "//auth.example.invalid", "http://127.0.0.1.example.invalid", True, 123, [], {},
        )
        for value in invalid:
            with self.subTest(value=value):
                self.write_config(attachments_issuer=value)
                with self.assertRaises(cli.FargoWorkError) as caught:
                    cli.Config.load()
                self.assertEqual(caught.exception.code, "invalid_config")
                config = self.config()
                config.attachments_issuer = value
                before = (self.home / "config.json").read_bytes()
                with self.assertRaises(cli.FargoWorkError):
                    config.save()
                self.assertEqual((self.home / "config.json").read_bytes(), before)
                with self.assertRaises(cli.FargoWorkError):
                    _ = config.effective_attachments_issuer

    def test_loopback_http_attachment_issuer_remains_available_for_local_trials(self):
        for origin in ("http://127.0.0.1:8081", "http://[::1]:8081", "http://localhost:8081"):
            with self.subTest(origin=origin):
                config = self.config(attachments_issuer=origin)
                config.save()
                self.assertEqual(cli.Config.load().effective_attachments_issuer, origin)

    def test_config_never_persists_loaded_or_in_memory_token_fields(self):
        marker = "synthetic-do-not-persist-credential-marker"
        self.write_config(attachments_issuer=ATTACHMENT_AUTH,
                          access_token=marker, refresh_token=marker, attachment_token=marker,
                          headers={"Authorization": marker})
        config = cli.Config.load()
        config.access_token = marker
        config.refresh_token = marker
        config.save()
        saved = (self.home / "config.json").read_text(encoding="utf-8")
        self.assertNotIn(marker, saved)
        self.assertEqual(json.loads(saved)["attachments_issuer"], ATTACHMENT_AUTH)


if __name__ == "__main__":
    unittest.main()
