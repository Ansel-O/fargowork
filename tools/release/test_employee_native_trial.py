"""Exercise the frozen Windows bundle in an isolated employee/client profile.

No OAuth login, browser, business request, or live user configuration is used.
Cursor is configuration-only; Codex registration uses its actual local CLI.
"""
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


def run(command: list[str], env: dict[str, str], *, input_text: str | None = None):
    result = subprocess.run(command, env=env, input=input_text, text=True,
                            capture_output=True, encoding="utf-8", timeout=90)
    return result, [json.loads(line) for line in result.stdout.splitlines()
                    if line.strip().startswith("{")]


def check(condition: bool, message: str):
    if not condition:
        raise RuntimeError(message)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--issuer", default="https://fargowork.fargowealthapp.com")
    parser.add_argument("--prototype-installer", type=Path,
                        help="diagnostic only: replace the installer before testing; cannot accept the frozen archive")
    args = parser.parse_args()
    archive = args.archive.resolve(strict=True)
    version = archive.name.removeprefix("fargowork-employee-v").removesuffix("-windows-x64.zip")
    check(os.name == "nt", "native acceptance requires Windows")
    summary = {"archive": archive.name, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
               "version": version, "checks": [], "real_oauth": "NOT_RUN", "host_ui": "NOT_RUN"}
    if args.prototype_installer:
        summary["frozen_archive_acceptance"] = False
        summary["prototype_installer"] = True
    with tempfile.TemporaryDirectory(prefix="fargowork-native-trial-") as temporary:
        root = Path(temporary)
        package = root / "package"
        with zipfile.ZipFile(archive) as source:
            check(all("/" not in entry.filename and "\\" not in entry.filename
                      for entry in source.infolist()), "unexpected outer archive path")
            source.extractall(package)
        if args.prototype_installer:
            shutil.copy2(args.prototype_installer.resolve(strict=True), package / "install.ps1")
        selected = ["manual", "cursor"]
        if shutil.which("codex"):
            selected.append("codex")
        else:
            summary["codex_native_registration"] = "NOT_RUN: CLI unavailable"
        for target in selected:
            profile = root / ("隔离 用户 " + target)
            profile.mkdir()
            env = dict(os.environ)
            for name in list(env):
                if name.startswith("FARGOWORK_"):
                    del env[name]
            env.update(USERPROFILE=str(profile), HOME=str(profile),
                       APPDATA=str(profile / "AppData" / "Roaming"),
                       LOCALAPPDATA=str(profile / "AppData" / "Local"),
                       CODEX_HOME=str(profile / ".codex"), CLAUDE_CONFIG_DIR="",
                       PYTHONIOENCODING="utf-8")
            cursor_path = profile / ".cursor" / "mcp.json"
            cursor_path.parent.mkdir()
            foreign = {"command": "foreign-sentinel", "args": ["keep"]}
            cursor_path.write_text(json.dumps({"mcpServers": {"foreign": foreign},
                                              "private_preference": "keep"}), encoding="utf-8")
            preference = profile / "personal-preferences.md"
            preference.write_text("personal preference sentinel", encoding="utf-8")
            command = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                       "-File", str(package / "install.ps1"), "-Version", version,
                       "-Target", target, "-ServiceIssuer", args.issuer,
                       "-LocalArtifactDir", str(package), "-OutputJsonl"]
            result, events = run(command, env)
            check(result.returncode == 0 and events, f"native {target} installer failed: {result.stdout[-1500:]}")
            installed = events[-1]
            check(installed.get("installed") is True and installed.get("connected") is None
                  and installed.get("identity_verified") is False, "installer claimed unauthenticated connectivity")
            check(installed["targets"][0]["target"] == target, "installer target contract differs")
            employee = Path(env["APPDATA"]) / "FargoWork" / "employee"
            check(installed["manual_mcp_registration"]["command"] ==
                  str(employee / "plugin" / "fargowork-employee" / "bin" / "fargowork.exe"),
                  "installer corrupted the Unicode manual command path")
            exe = employee / "bin" / "fargowork.exe"
            native, _ = run([str(exe), "--version"], env)
            check(native.returncode == 0 and native.stdout.strip() == version, "native version differs")
            canonical = employee / "skills" / "fargowork-employee" / "SKILL.md"
            check(canonical.is_file(), "canonical employee Skill missing")
            doctor, events = run([str(exe), "doctor", "--target", target, "--output", "jsonl"], env)
            check(doctor.returncode == 3 and events[-1]["connected"] is None
                  and events[-1]["identity_verified"] is False, "doctor claimed a live identity")
            status, events = run([str(exe), "status", "--target", target, "--output", "jsonl"], env)
            check(status.returncode == 3 and events[-1]["connected"] is False
                  and events[-1]["identity_verified"] is False, "status accepted missing credentials")
            bridge_input = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                       "params": {"protocolVersion": "2025-11-25", "capabilities": {},
                                                  "clientInfo": {"name": "isolated-native-fixture", "version": "1"}}}) + "\n"
            _, events = run([str(exe), "bridge"], env, input_text=bridge_input)
            check(events and "error" in events[-1], "unauthenticated bridge did not reject the request")
            if target == "manual":
                changed_skill = canonical.read_bytes() + b"\nLocal preference sentinel.\n"
                canonical.write_bytes(changed_skill)
                repair, events = run([str(exe), "repair", "--target", "manual", "--output", "jsonl"], env)
                check(repair.returncode == 3 and events[-1].get("event") == "error"
                      and events[-1].get("needs_user_action") is True
                      and canonical.read_bytes() == changed_skill,
                      f"native modified-Skill refusal differs (exit={repair.returncode}, "
                      f"code={events[-1].get('code') if events else None}, "
                      f"preserved={canonical.read_bytes() == changed_skill})")
            configured = json.loads(cursor_path.read_text(encoding="utf-8"))
            check(configured["mcpServers"]["foreign"] == foreign
                  and configured["private_preference"] == "keep", "foreign Cursor config changed")
            if target == "cursor":
                entry = configured["mcpServers"]["fargowork-employee"]
                check(entry["args"] == ["bridge"] and Path(entry["command"]).is_file(), "Cursor bridge config invalid")
                check((profile / ".cursor" / "skills" / "fargowork-employee" / "SKILL.md").is_file(), "Cursor Skill missing")
                uninstall, events = run([str(exe), "uninstall", "--target", target, "--output", "jsonl"], env)
                check(uninstall.returncode == 0 and events[-1]["clients"]["cursor"]["uninstalled"], "Cursor owned removal failed")
                configured = json.loads(cursor_path.read_text(encoding="utf-8"))
                check("fargowork-employee" not in configured["mcpServers"]
                      and configured["mcpServers"]["foreign"] == foreign, "Cursor removal affected foreign entry")
            elif target == "codex":
                codex_config = profile / ".codex" / "config.toml"
                check(codex_config.is_file() and "fargowork-employee" in codex_config.read_text(encoding="utf-8"), "Codex official registration missing")
                uninstall, events = run([str(exe), "uninstall", "--target", target, "--output", "jsonl"], env)
                check(uninstall.returncode == 0 and events[-1]["clients"]["codex"]["uninstalled"], "Codex owned removal failed")
            check(preference.read_text(encoding="utf-8") == "personal preference sentinel", "personal preference changed")
            summary["checks"].append({"target": target, "native_install_doctor_status": "PASS",
                                      "anonymous_bridge_rejected": "PASS",
                                      "foreign_configuration_preserved": "PASS",
                                      "owned_uninstall": "NOT_RUN" if target == "manual" else "PASS"})
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
