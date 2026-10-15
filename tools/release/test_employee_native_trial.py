"""Exercise a CLI-only local Windows bundle using isolated, synthetic profiles."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

def run(command, env):
    result = subprocess.run(command, env=env, capture_output=True, text=True, encoding='utf-8', timeout=90)
    return result, [json.loads(line) for line in result.stdout.splitlines() if line.strip().startswith('{')]

def check(condition, message):
    if not condition:
        raise RuntimeError(message)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--issuer', default='https://fargowork.fargowealthapp.com')
    parser.add_argument('--prototype-installer', type=Path)
    args = parser.parse_args()
    archive = args.archive.resolve(strict=True)
    version = archive.name.removeprefix('fargowork-employee-v').removesuffix('-windows-x64.zip')
    check(os.name == 'nt', 'native acceptance requires Windows')
    summary = dict(archive=archive.name, sha256=hashlib.sha256(archive.read_bytes()).hexdigest(), version=version,
                   checks=[], real_oauth='NOT_RUN', host_ui='NOT_RUN', legacy_layout='synthetic-old-contract')
    if args.prototype_installer:
        summary['frozen_archive_acceptance'] = False
    with tempfile.TemporaryDirectory(prefix='fargowork-native-trial-') as temporary:
        root = Path(temporary)
        package = root / 'package'
        with zipfile.ZipFile(archive) as source:
            check(all('/' not in item.filename and '\\' not in item.filename for item in source.infolist()), 'unexpected outer archive path')
            check(not any('bridge' in name.lower() for name in source.namelist()), 'candidate still ships a Bridge archive')
            source.extractall(package)
        if args.prototype_installer:
            shutil.copy2(args.prototype_installer.resolve(strict=True), package / 'install.ps1')
        for case in ('fresh', 'owned-legacy', 'modified-legacy', 'foreign-legacy'):
            profile = root / ('隔离 用户 ' + case)
            profile.mkdir()
            env = {key: value for key, value in os.environ.items() if not key.startswith('FARGOWORK_')}
            env.update(USERPROFILE=str(profile), HOME=str(profile), APPDATA=str(profile / 'AppData/Roaming'),
                       LOCALAPPDATA=str(profile / 'AppData/Local'), CODEX_HOME=str(profile / '.codex'), CLAUDE_CONFIG_DIR='', PYTHONIOENCODING='utf-8')
            cursor = profile / '.cursor/mcp.json'
            cursor.parent.mkdir()
            foreign = dict(command='foreign-sentinel', args=['keep'])
            cursor.write_text(json.dumps(dict(mcpServers=dict(foreign=foreign), preference='keep')))
            cursor_before = cursor.read_bytes()
            command = ['powershell.exe', '-NoProfile', '-File', str(package / 'install.ps1'), '-Version', version,
                       '-Target', 'cli', '-ServiceIssuer', args.issuer, '-LocalArtifactDir', str(package), '-OutputJsonl']
            first, events = run(command, env)
            check(first.returncode == 0 and len(events) == 1, 'native CLI installer failed or emitted phase reports')
            installed = events[-1]
            check(installed.get('installed') is True and installed.get('connected') is None and installed.get('identity_verified') is False, 'installer claimed an unauthenticated identity')
            check(installed.get('business_cli_available') is True and installed.get('mcp_registration_required') is False and 'manual_mcp_registration' not in installed, 'CLI installation still requires host registration')
            employee = Path(env['APPDATA']) / 'FargoWork/employee'
            plugin = employee / 'plugin/fargowork-employee'
            exe = employee / 'bin/fargowork.exe'
            check((employee / 'skills/fargowork-employee/SKILL.md').is_file() and not (plugin / 'mcp.json').exists() and not (plugin / 'bin').exists(), 'new install retained Bridge metadata/launcher or lost Skill')
            native, _ = run([str(exe), '--version'], env)
            check(native.returncode == 0 and native.stdout.strip() == version, 'native CLI version differs')
            rejected, _ = run([str(exe), 'bridge'], env)
            check(rejected.returncode == 2, 'retired bridge command is still accepted')
            check(cursor.read_bytes() == cursor_before, 'fresh install changed unrelated host config')
            for action in ('doctor', 'status'):
                result, events = run([str(exe), action, '--output', 'jsonl'], env)
                check(result.returncode == 3 and events[-1]['identity_verified'] is False, 'unauthenticated status/doctor claimed identity')
            if case != 'fresh':
                legacy = {'mcp.json': b'{"mcpServers":{}}', 'bin/fargowork.cmd': b'fixture legacy launcher', 'bin/fargowork.exe': b'fixture legacy executable'}
                manifest = dict(files=[])
                for relative, data in legacy.items():
                    subject = plugin / relative
                    subject.parent.mkdir(parents=True, exist_ok=True)
                    subject.write_bytes(data)
                    manifest['files'].append(dict(path=relative, size=len(data), sha256=hashlib.sha256(data).hexdigest()))
                (plugin / 'PACKAGE-MANIFEST.json').write_text(json.dumps(manifest))
                entry = dict(type='stdio', command=str(plugin / 'bin/fargowork.exe'), args=['bridge'])
                data = dict(mcpServers={'foreign': foreign, 'fargowork-employee': dict(entry)}, preference='keep')
                if case == 'foreign-legacy':
                    data['mcpServers']['fargowork-employee']['args'] = ['user-modified']
                cursor.write_text(json.dumps(data))
                old_cursor = cursor.read_bytes()
                sidecar = employee / 'adapters/cursor.json'
                sidecar.parent.mkdir(exist_ok=True)
                sidecar.write_text(json.dumps(dict(owner='fargowork-owned-v1', registration='official-cursor-user-json', entry=entry)))
                state = employee / 'state'
                state.mkdir(exist_ok=True)
                credential = state / 'vault.fixture'
                credential.write_bytes(b'fixture-private-vault')
                preferences = employee / 'profiles/preferences.fixture'
                preferences.parent.mkdir(exist_ok=True)
                preferences.write_bytes(b'fixture employee preference')
                if case == 'modified-legacy':
                    (plugin / 'bin/fargowork.cmd').write_bytes(b'user modified launcher')
                updated, events = run(command, env)
                check(updated.returncode == 0 and len(events) == 1, 'native legacy upgrade failed or emitted phase reports')
                result = events[-1]
                current = json.loads(cursor.read_text())
                if case == 'foreign-legacy':
                    check(cursor.read_bytes() == old_cursor and result.get('legacy_connection_review_required') is True, 'foreign legacy entry deleted or warning missing')
                else:
                    check('fargowork-employee' not in current['mcpServers'] and not sidecar.exists(), 'exact old registration not removed')
                check(current['mcpServers']['foreign'] == foreign and current['preference'] == 'keep', 'upgrade changed unrelated host values')
                if case == 'modified-legacy':
                    recovery = Path(result.get('recovery_path', ''))
                    check(result.get('legacy_bridge_files_preserved') is True and (recovery / 'backup/plugin/bin/fargowork.cmd').read_bytes() == b'user modified launcher', 'modified Bridge bytes not preserved')
                else:
                    check(result.get('legacy_bridge_files_preserved') is False, 'unchanged Bridge bytes incorrectly retained')
                check(credential.read_bytes() == b'fixture-private-vault' and preferences.read_bytes() == b'fixture employee preference', 'upgrade changed private state')
                check(not (plugin / 'mcp.json').exists() and not (plugin / 'bin').exists(), 'active upgraded package still contains Bridge files')
            summary['checks'].append(dict(case=case, install_and_native_entry='PASS', legacy_migration='PASS' if case != 'fresh' else 'NOT_RUN', private_state_preserved='PASS'))
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
