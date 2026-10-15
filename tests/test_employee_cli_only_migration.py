"""CLI-only delivery removes only strictly proven legacy host connections."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load_cli():
    spec = importlib.util.spec_from_file_location('employee_cli_only_fixture', ROOT / 'public/cli/fargowork_cli.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class CLIOnlyMigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cli = load_cli()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.profile = Path(self.temp.name)
        self.home_patch = patch.object(Path, 'home', return_value=self.profile)
        self.home_patch.start()
        self.env_patch = patch.dict(os.environ, {'CODEX_HOME': str(self.profile / '.codex'), 'CLAUDE_CONFIG_DIR': ''})
        self.env_patch.start()
        self.config = self.cli.Config(home=self.profile / 'employee', issuer='https://fixture.invalid', resource='https://fixture.invalid/mcp')
        self.config.home.mkdir()
        (self.config.home / 'adapters').mkdir()
        self.migration = self.cli.LegacyBridgeMigration(self.config)

    def tearDown(self):
        self.env_patch.stop()
        self.home_patch.stop()
        self.temp.cleanup()

    def entry(self):
        return {'type': 'stdio', 'command': self.migration._native_bridge_command(), 'args': ['bridge']}

    def cursor(self, entry, *, receipt=True):
        path = self.profile / '.cursor/mcp.json'
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps({'mcpServers': {'fargowork-employee': entry, 'other': {'command': 'keep'}}, 'preference': 'keep'}), encoding='utf-8')
        if receipt:
            self.receipt('cursor', {'registration': 'official-cursor-user-json', 'entry': self.entry()})
        return path

    def receipt(self, name, fields):
        path = self.config.home / 'adapters' / f'{name}.json'
        path.write_text(json.dumps({'owner': self.cli.MARKER, **fields}), encoding='utf-8')
        return path

    def test_no_bridge_or_registration_parser_and_no_host_execution_on_fresh_install(self):
        self.assertFalse(hasattr(self.cli, 'run_bridge'))
        parser = self.cli._build_parser()
        self.assertEqual(parser.parse_args(['install']).target, 'cli')
        for args in (['bridge'], ['install', '--target', 'cursor'], ['install', '--registration-mode', 'official']):
            with self.subTest(args=args), self.assertRaises(SystemExit):
                parser.parse_args(args)
        with patch.object(self.cli.subprocess, 'run', side_effect=AssertionError('fresh CLI may not invoke host executable')):
            state = self.cli.ClientAdapters(self.config).register('cli')
        self.assertFalse(state['cli']['registered'])
        self.assertFalse(state['cli']['needs_user_action'])
        self.assertFalse((self.profile / '.cursor').exists())

    def test_exact_cursor_owned_entry_removed_and_unrelated_config_preserved(self):
        path = self.cursor(self.entry())
        result = self.migration.migrate()['cursor']
        self.assertEqual(result['status'], 'removed')
        data = json.loads(path.read_text())
        self.assertEqual(data, {'mcpServers': {'other': {'command': 'keep'}}, 'preference': 'keep'})
        self.assertFalse((self.config.home / 'adapters/cursor.json').exists())

    def test_foreign_or_modified_cursor_entry_preserved_byte_for_byte(self):
        cases = [(self.entry(), False), ({**self.entry(), 'env': {'CUSTOM': 'keep'}}, True), ({**self.entry(), 'command': 'foreign.exe'}, True)]
        for entry, receipt in cases:
            with self.subTest(entry=entry, receipt=receipt):
                path = self.cursor(entry, receipt=receipt)
                before = path.read_bytes()
                result = self.migration.migrate()['cursor']
                self.assertEqual(result['status'], 'preserved')
                self.assertTrue(result['needs_user_action'])
                self.assertEqual(path.read_bytes(), before)
                (self.config.home / 'adapters/cursor.json').unlink(missing_ok=True)

    def test_unreadable_or_duplicate_host_config_is_preserved(self):
        path = self.cursor(self.entry())
        for raw in (b'not json', b'{"mcpServers":{},"mcpServers":{}}'):
            path.write_bytes(raw)
            result = self.migration.migrate()['cursor']
            self.assertTrue(result['needs_user_action'])
            self.assertEqual(path.read_bytes(), raw)

    def test_claude_exact_owned_entry_removed_without_host_cli(self):
        path = self.profile / '.claude.json'
        path.write_text(json.dumps({'mcpServers': {'fargowork-employee': self.entry()}, 'preference': 'keep'}))
        self.receipt('claude-code', {'registration': 'official-claude-code-user', 'entry': self.entry()})
        with patch.object(self.cli.subprocess, 'run', side_effect=AssertionError('direct proven user entry needs no host process')):
            result = self.migration.migrate()['claude-code']
        self.assertEqual(result['status'], 'removed')
        self.assertEqual(json.loads(path.read_text()), {'mcpServers': {}, 'preference': 'keep'})

    def test_old_workbuddy_substring_receipt_is_insufficient_and_preserved(self):
        path = self.receipt('workbuddy', {'registration': 'official-codebuddy-user', 'command': self.migration._bridge_command(), 'args': ['bridge']})
        before = path.read_bytes()
        with patch.object(self.cli.subprocess, 'run', side_effect=AssertionError('unproven CodeBuddy connection must not mutate')):
            result = self.migration.migrate()['workbuddy']
        self.assertEqual(result['status'], 'preserved')
        self.assertEqual(path.read_bytes(), before)

    def test_codex_exact_owned_receipt_requires_native_verification(self):
        path = self.receipt('codex', {'registration': 'official-codex-cli', 'command': self.migration._bridge_command(), 'args': ['bridge'], 'env': {}, 'cwd': None})
        native = {'name': 'fargowork-employee', 'enabled': True,
                  'transport': {'type': 'stdio', 'command': self.migration._bridge_command(), 'args': ['bridge'], 'env': {}, 'env_vars': [], 'cwd': None}}
        with patch.object(self.migration, '_detect_codex', return_value={'detected': True, 'executable': 'codex'}), patch.object(self.migration, '_codex_mcp_state', side_effect=[{'status': 'present', 'entry': native}, {'status': 'absent'}]), patch.object(self.cli.subprocess, 'run', return_value=__import__('subprocess').CompletedProcess([], 0)) as call:
            result = self.migration._codex_registration()
        self.assertEqual(result['status'], 'removed')
        self.assertEqual(call.call_args.args[0], ['codex', 'mcp', 'remove', 'fargowork-employee'])
        self.assertFalse(path.exists())

    def test_codex_changed_entry_and_fixture_receipt_never_remove(self):
        path = self.receipt('codex', {'registration': 'fargowork-owned-fixture'})
        with patch.object(self.cli.subprocess, 'run', side_effect=AssertionError('fixture receipt is not ownership proof')):
            result = self.migration._codex_registration()
        self.assertEqual(result['status'], 'preserved')
        self.assertTrue(path.exists())


if __name__ == '__main__':
    unittest.main()
