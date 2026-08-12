# FargoWork

FargoWork connects AI agents to governed DingTalk/Yida office workflows through
a standard Agent Plugin, a local CLI/stdio bridge, and FargoWork OAuth + PKCE.

This public repository contains client-side delivery material only. The Server,
workflow rules, Yida field and permission facts, production configuration,
credentials, runtime state, and business data are maintained separately and are
not published here.

## Office pilot release

The first downloadable office pilot release is `v0.5.0-rc.3`. Remote installation becomes
available only after that immutable GitHub Release is published with Windows and
Linux artifacts plus `SHA256SUMS`.

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/Ansel-O/fargowork/v0.5.0-rc.3/public/install.ps1 | iex
```

Linux shell:

```sh
curl -fsSL https://raw.githubusercontent.com/Ansel-O/fargowork/v0.5.0-rc.3/public/install.sh | sh
```

The installer verifies SHA-256 checksums, installs one FargoWork CLI and Agent
Plugin, detects supported clients, and registers FargoWork where the client has
a verified registration contract. WorkBuddy keeps its own manual trust/enable
step. Unknown clients can use the generic stdio JSON returned by `fargowork
doctor` or `fargowork status`.

Login remains a separate product action. When a command requires identity and
the local session cannot refresh, run:

```text
fargowork login
```

FargoWork uses the DingTalk enterprise identity selected during OAuth. Access
tokens are short-lived; refresh credentials stay in the operating system's
secure vault.

This RC defaults to the office Pilot service at
`https://fargowork.ansel.vip/mcp`. Local Server development remains supported
through explicit `FARGOWORK_ISSUER`, `FARGOWORK_RESOURCE`, and
`FARGOWORK_RESOURCE_METADATA_URI` overrides; it is not the employee install
default.

## Supported client platforms

- Windows x64: CLI, stdio bridge, DPAPI vault, PowerShell installer.
- Linux x64: CLI, stdio bridge, Secret Service vault, shell installer.
- macOS: not emitted by this RC until native Keychain support is complete.

The current release declares exact support for MCP `2026-07-28`, Agent Plugins
`1.0.0`, and governed `action_result` contract v1. It does not claim wildcard
compatibility with future breaking MCP revisions.

## Build from source

Build a native artifact on its matching host platform:

```powershell
python tools/release/build_local_release.py --platform windows --arch x64 --version 0.5.0-rc.3 --output-dir dist/release/local
```

The release workflow builds Windows x64 and Linux x64 separately. Public export
and package builders fail closed on unlisted files, unsafe ZIP paths,
secret-like content, unapproved endpoints, and checksum mismatches.

## License

The public FargoWork client, Agent Plugin, Skill, adapters, and installers are
licensed under the Apache License 2.0. Private Server components are not part of
this repository or license grant.
