[CmdletBinding()]
param(
    [string[]]$Target = @('manual'),
    [string]$Version = '1.2.0',
    [string]$ServiceIssuer,
    [string]$LocalArtifactDir,
    [string]$ReleaseBaseUrl,
    [switch]$Login,
    [ValidateSet('auto', 'always', 'never')]
    [string]$OpenBrowser = 'auto',
    [switch]$DryRun,
    [switch]$OutputJsonl,
    [string]$CodexPath,
    [string]$AttemptId
)

$ErrorActionPreference = 'Stop'
# Use this PowerShell runtime's built-in module even when an AI shell passed
# a PSModulePath containing modules from a different PowerShell version.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Force


# This fixed event writer shares one directory, namespace and byte lock with the
# CLI. No URL, identity, token, arbitrary message or native stderr is persisted.
function Resolve-InstallationAttempt {
    if ($AttemptId -and $AttemptId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
        throw '[attempt_id_invalid] AttemptId must be a canonical lowercase UUID.'
    }
    $script:attemptId = if ($AttemptId) { $AttemptId } else { [guid]::NewGuid().ToString('D') }
    $diagnosticBase = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $env:USERPROFILE 'AppData\Roaming' }
    $script:diagnosticDirectory = Join-Path $diagnosticBase 'FargoWork\diagnostics'
    $script:diagnosticUnavailable = $false
}

function Assert-DiagnosticPath([string]$Path) {
    if (-not [IO.Path]::IsPathRooted($Path)) { throw 'Unsafe diagnostic path.' }
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked diagnostic path.' }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Assert-DiagnosticSingleLink([IO.FileStream]$Stream) {
    if (-not ('FargoWorkDiagnosticFileInfo' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class FargoWorkDiagnosticFileInfo {
    [StructLayout(LayoutKind.Sequential)]
    public struct Info {
        public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh;
        public uint WriteLow, WriteHigh, VolumeSerial, SizeHigh, SizeLow;
        public uint Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle h, StringBuilder path, uint length, uint flags);
    public static bool SingleLink(SafeFileHandle h, string expected) {
        Info info;
        if (!GetFileInformationByHandle(h, out info) || info.Links != 1) return false;
        StringBuilder path = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandle(h, path, (uint)path.Capacity, 0);
        if (length == 0 || length >= path.Capacity) return false;
        string actual = path.ToString();
        if (actual.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) actual = @"\\" + actual.Substring(8);
        else if (actual.StartsWith(@"\\?\", StringComparison.Ordinal)) actual = actual.Substring(4);
        return String.Equals(Path.GetFullPath(actual), Path.GetFullPath(expected), StringComparison.OrdinalIgnoreCase);
    }
}
'@
    }
    if (-not [FargoWorkDiagnosticFileInfo]::SingleLink($Stream.SafeFileHandle, $Stream.Name)) { throw 'Linked diagnostic file.' }
}

function Write-InstallationDiagnostic([string]$Event, [string]$Phase, [string]$Outcome,
                                      [string]$ErrorCode = '', [int]$ExitCode = -9999) {
    $events = @('installation_started', 'preflight_result', 'package_verified', 'files_staged',
                'client_detection_result', 'client_registration_result', 'installation_finished',
                'launcher_started', 'launcher_finished')
    $phases = @('start', 'preflight', 'download', 'verify', 'stage', 'detect', 'register', 'login', 'identity', 'finish', 'cleanup')
    $outcomes = @('started', 'succeeded', 'failed', 'rejected', 'unavailable', 'skipped', 'pending', 'not_attempted')
    $errors = @('attempt_id_invalid', 'client_not_detected', 'codex_path_invalid', 'client_probe_failed',
                'artifact_invalid', 'installation_failed', 'registration_failed', 'login_failed',
                'identity_verification_failed', 'permission_denied', 'incomplete_install',
                'unsafe_path', 'diagnostic_failed', 'unknown_error')
    if (-not $script:attemptId -or $Event -cnotin $events -or $Phase -cnotin $phases -or $Outcome -cnotin $outcomes) { return }
    if ($ErrorCode -and $ErrorCode -cnotin $errors) { $ErrorCode = 'unknown_error' }
    $safeVersion = if ($Version -cmatch '^(\d{1,4}\.\d{1,4}\.\d{1,4})(?:-[A-Za-z0-9.-]{1,32})?$') { $Matches[1] } else { '0.0.0' }
    $record = [ordered]@{
        timestamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        component = $script:diagnosticComponent
        event = $Event; phase = $Phase; attempt_id = $script:attemptId
        pid = $PID; version = $safeVersion; outcome = $Outcome
    }
    if ($ErrorCode) { $record.error_code = $ErrorCode }
    if ($ExitCode -ne -9999) { $record.exit_code = $ExitCode }
    $lock = $null
    $locked = $false
    try {
        Assert-DiagnosticPath $script:diagnosticDirectory
        if (Test-Path -LiteralPath $script:diagnosticDirectory) {
            if (-not (Test-Path -LiteralPath $script:diagnosticDirectory -PathType Container)) { throw 'Diagnostic directory is not a directory.' }
        } else { [IO.Directory]::CreateDirectory($script:diagnosticDirectory) | Out-Null }
        Assert-DiagnosticPath $script:diagnosticDirectory
        $lockPath = Join-Path $script:diagnosticDirectory '.diagnostics.lock'
        Assert-DiagnosticPath $lockPath
        $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
        Assert-DiagnosticSingleLink $lock
        $deadline = [DateTime]::UtcNow.AddSeconds(0.25)
        do {
            try { $lock.Lock(0, 1); $locked = $true } catch [IO.IOException] {
                if ([DateTime]::UtcNow -ge $deadline) { throw }
                Start-Sleep -Milliseconds 20
            }
        } while (-not $locked)
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($record | ConvertTo-Json -Compress -Depth 3) + "`n")
        if ($bytes.Length -gt 2048) { throw 'Diagnostic event exceeds its bound.' }
        $known = @()
        [long]$total = 0
        foreach ($item in @(Get-ChildItem -LiteralPath $script:diagnosticDirectory -Force)) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer) { throw 'Unverifiable diagnostic directory entry.' }
            $reader = [IO.File]::Open($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
            try { Assert-DiagnosticSingleLink $reader } finally { $reader.Dispose() }
            if ($item.Name -cmatch '^diagnostic-(\d{4}-\d{2}-\d{2})-(\d{6})\.jsonl$') {
                $itemDate = [DateTime]::ParseExact($Matches[1], 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
                if ($item.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-7)) {
                    Remove-Item -LiteralPath $item.FullName -Force
                    continue
                }
                if ($item.Length -gt 2097152) { throw 'Diagnostic file exceeds its bound.' }
                $known += $item
            }
            $total += $item.Length
        }
        $today = [DateTime]::UtcNow.ToString('yyyy-MM-dd')
        $todayFiles = @($known | Where-Object { $_.Name -cmatch ('^diagnostic-' + $today + '-\d{6}\.jsonl$') } | Sort-Object Name)
        $active = if ($todayFiles.Count -gt 0) { $todayFiles[-1] } else { $null }
        if ($active -and $active.Length + $bytes.Length -gt 2097152) { $active = $null }
        if ($active) { $destination = $active.FullName } else {
            $sequence = if ($todayFiles.Count -gt 0) { [int]$todayFiles[-1].Name.Substring(22, 6) + 1 } else { 1 }
            if ($sequence -gt 999999) { throw 'Diagnostic sequence exhausted.' }
            $destination = Join-Path $script:diagnosticDirectory ('diagnostic-' + $today + '-' + $sequence.ToString('D6') + '.jsonl')
        }
        foreach ($old in @($known | Sort-Object LastWriteTimeUtc, Name)) {
            if ($total + $bytes.Length -le 20971520) { break }
            if ($old.FullName -ceq $destination) { continue }
            Remove-Item -LiteralPath $old.FullName -Force
            $total -= $old.Length
        }
        if ($total + $bytes.Length -gt 20971520) { throw 'Diagnostic total budget is unavailable.' }
        Assert-DiagnosticPath $destination
        $writer = [IO.File]::Open($destination, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
        try {
            Assert-DiagnosticSingleLink $writer
            $writer.Seek(0, [IO.SeekOrigin]::End) | Out-Null
            $writer.Write($bytes, 0, $bytes.Length)
            $writer.Flush()
        } finally { $writer.Dispose() }
    } catch { $script:diagnosticUnavailable = $true }
    finally {
        if ($lock) { if ($locked) { try { $lock.Unlock(0, 1) } catch {} }; $lock.Dispose() }
    }
}

function Invoke-HostPreflight([string[]]$Targets) {
    if ($CodexPath -and 'codex' -notin $Targets) { throw '[codex_path_invalid] CodexPath requires the codex target.' }
    if ('codex' -notin $Targets) { return }
    $candidate = $CodexPath
    if (-not $candidate) {
        $command = Get-Command -Name 'codex.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) { $candidate = $command.Source }
    }
    if (-not $candidate) {
        throw '[client_not_detected] Codex was not found on PATH. For an embedded host, provide its verified absolute native executable with -CodexPath; no package was downloaded or installed.'
    }
    if (-not [IO.Path]::IsPathRooted($candidate) -or [IO.Path]::GetExtension($candidate) -ine '.exe' -or
        -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw '[codex_path_invalid] CodexPath must name an existing absolute native .exe file.'
    }
    Assert-DiagnosticPath $candidate
    $probe = [Diagnostics.Process]::new()
    try {
        $probe.StartInfo = [Diagnostics.ProcessStartInfo]::new()
        $probe.StartInfo.FileName = [IO.Path]::GetFullPath($candidate)
        $probe.StartInfo.Arguments = '--version'
        $probe.StartInfo.UseShellExecute = $false
        $probe.StartInfo.CreateNoWindow = $true
        $probe.StartInfo.RedirectStandardOutput = $true
        $probe.StartInfo.RedirectStandardError = $true
        $probe.Start() | Out-Null
        $standardOutput = $probe.StandardOutput.ReadToEndAsync()
        $standardError = $probe.StandardError.ReadToEndAsync()
        if (-not $probe.WaitForExit(5000)) {
            $probe.Kill()
            throw '[client_probe_failed] Codex version check timed out; installation stopped.'
        }
        $probe.WaitForExit()
        if ($probe.ExitCode -ne 0 -or $standardOutput.Result.Length -gt 1024 -or
            $standardOutput.Result -notmatch '^codex-cli [0-9]+\.[0-9]+\.[0-9]+') {
            throw '[client_probe_failed] The supplied executable did not report a supported native Codex CLI; installation stopped.'
        }
        $script:resolvedCodexPath = [IO.Path]::GetFullPath($candidate)
    } finally { $probe.Dispose() }
}

function Get-InstallationErrorCode([string]$Message, [string]$Fallback = 'installation_failed') {
    if ($Message -match '^\[([a-z][a-z0-9_]+)\]') { return $Matches[1] }
    return $Fallback
}

function Emit-Result([hashtable]$Payload) {
    $Payload.attempt_id = $script:attemptId
    $Payload.diagnostic_log_dir = $script:diagnosticDirectory
    $Payload.diagnostic_available = -not $script:diagnosticUnavailable
    if ($OutputJsonl) {
        $Payload | ConvertTo-Json -Compress -Depth 10
    } else {
        $detail = if ($Payload.message) { $Payload.message } elseif ($Payload.status) { $Payload.status } else { '' }
        Write-Output ("{0}: {1}" -f $Payload.event, $detail)
        foreach ($result in @($Payload.targets | Where-Object { $null -ne $_ })) {
            Write-Output ("{0}: {1}" -f $result.target, $result.status)
        }
        if ($Payload.manual_mcp_registration) {
            Write-Output 'Standard stdio MCP configuration:'
            $Payload.manual_mcp_registration.config | ConvertTo-Json -Depth 10
            Write-Output ("Skill: {0}" -f $Payload.skill_path)
        }
        if ($Payload.login_command) { Write-Output ("Login: {0}" -f $Payload.login_command) }
    }
}

function Resolve-Targets([string[]]$Values) {
    $allowed = @('manual', 'codex', 'cursor', 'workbuddy', 'claude-code')
    $selected = [System.Collections.Generic.List[string]]::new()
    foreach ($value in $Values) {
        foreach ($part in $value.Split(',')) {
            $name = $part.Trim().ToLowerInvariant()
            if ($name -notin $allowed) { throw "Unsupported FargoWork target: $name. Choose manual, codex, cursor, workbuddy, or claude-code." }
            if (-not $selected.Contains($name)) { $selected.Add($name) }
        }
    }
    if ($selected.Count -eq 0) { throw 'At least one FargoWork target is required.' }
    return $selected.ToArray()
}

function Invoke-EmployeeCli([string]$Exe, [string[]]$Arguments) {
    # Keep identity responses in memory. Only the interactive authorization URL
    # is streamed so browser=never remains usable while the CLI waits.
    $capture = @{ payload = $null }
    $previousErrorPreference = $ErrorActionPreference
    try {
        # Windows PowerShell converts native stderr into ErrorRecords. Keep
        # those inside the filter rather than terminating with raw stderr.
        $ErrorActionPreference = 'Continue'
        & $Exe @Arguments 2>&1 | ForEach-Object {
        try {
            $event = [string]$_ | ConvertFrom-Json -ErrorAction Stop
            if ($event.event -eq 'login_authorization_url') {
                if ($OutputJsonl) { Write-Host ($event | ConvertTo-Json -Compress -Depth 10) }
                else { Write-Host ("Open this login URL: {0}" -f $event.url) }
            } elseif ($event.event -in @('installed', 'doctor', 'logged_in', 'status', 'error')) {
                $capture.payload = $event
            } elseif ($event.event -in @('login_started', 'listener_ready', 'browser_open_result', 'authorization_waiting',
                                         'callback_rejected', 'callback_accepted', 'token_request_result', 'identity_result')) {
                $safeProgress = @{ event = $event.event; attempt_id = $script:attemptId }
                if ($event.phase -cin @('login', 'listener', 'browser', 'callback', 'token', 'identity')) { $safeProgress.phase = $event.phase }
                if ($event.outcome -cin @('started', 'succeeded', 'failed', 'rejected', 'waiting', 'unavailable', 'cancelled', 'matched', 'mismatch', 'accepted', 'denied')) { $safeProgress.outcome = $event.outcome }
                if ($event.error_code -cin @('callback_port_unavailable', 'oauth_state_mismatch', 'oauth_issuer_mismatch', 'oauth_callback_invalid', 'oauth_callback_timeout', 'browser_unavailable', 'auth_required', 'token_exchange_failed', 'identity_verification_failed')) { $safeProgress.error_code = $event.error_code }
                if ($event.exit_code -is [int] -or $event.exit_code -is [long]) { $safeProgress.exit_code = $event.exit_code }
                if ($event.matched -is [bool]) { $safeProgress.matched = $event.matched }
                if ($OutputJsonl) { Write-Host ($safeProgress | ConvertTo-Json -Compress -Depth 3) }
                else { Write-Host ("{0}: {1}" -f $safeProgress.event, $safeProgress.outcome) }
            }
        } catch {
            # Unexpected native diagnostics are not copied into structured logs.
        }
        }
    } finally { $ErrorActionPreference = $previousErrorPreference }
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Payload = $capture.payload }
}

function Get-SafeClientFailure([object]$Payload, [string]$Target, [string]$Phase, [int]$ExitCode) {
    $reason = $null
    $client = if ($Payload.clients) { $Payload.clients.$Target } else { $null }
    $fixedReasons = @(
        'Codex is not installed; skipped.', 'Cursor is not installed; skipped.', 'WorkBuddy is not installed; skipped.',
        'Claude Code is not installed; skipped.', 'existing non-FargoWork entry preserved',
        'Import the stdio MCP entry and the employee Skill in your client; client registration and trust were not inspected.',
        'MCP is registered; WorkBuddy UI trust/enable is still required.',
        'MCP configuration is verified; Cursor runtime connection and UI trust were not checked.',
        'User-scope MCP configuration is verified; Claude Code runtime connection and approvals were not checked.',
        'Configured Codex executable is unavailable; use --codex-path with the current path. No alternate executable was guessed.',
        'CodeBuddy MCP status could not be read; no registration was attempted.',
        'CodeBuddy already has a FargoWork-named MCP entry not owned by this installation; it was preserved.',
        'CodeBuddy user-scope MCP registration failed; retry repair.',
        'CodeBuddy did not report the expected user-scope FargoWork command after registration; ownership was not recorded.',
        'Cursor has a same-name MCP entry without matching FargoWork ownership; it was preserved.',
        'Claude Code has a same-name entry without matching FargoWork ownership; it was preserved.',
        'Codex MCP configuration could not be verified; no registration was attempted.',
        'Codex already has a same-name MCP entry that is not an exact FargoWork-owned registration; it was preserved.',
        'Codex official registration command failed; inspect Codex configuration and retry.',
        'Codex official registration could not be confirmed; no ownership was recorded.',
        'Codex did not report the exact FargoWork command, arguments, and environment after registration; ownership was not recorded.'
    )
    if ($client -and $client.reason -cin $fixedReasons) { $reason = [string]$client.reason }
    $fixedCodes = @{
        skill_missing = 'The employee package is incomplete: its core Skill is missing.'
        modified_skill_preserved = 'The official Skill has local changes; they were preserved.'
        ownership_conflict = 'An existing unowned path was preserved; installation stopped.'
        unsafe_path = 'A linked or unsafe installation path was rejected.'
        registration_rollback_required = 'Host registration recovery requires review; referenced employee files were retained.'
        invalid_client_config = 'The existing host configuration could not be safely read; it was preserved.'
        client_config_changed = 'The host configuration changed during registration; it was preserved.'
        codex_path_invalid = 'The supplied Codex executable path is invalid.'
        client_not_detected = 'Codex was not detected; provide its verified absolute executable with -CodexPath.'
    }
    if (-not $reason -and $Payload.code -and $fixedCodes.ContainsKey([string]$Payload.code)) { $reason = $fixedCodes[[string]$Payload.code] }
    if (-not $reason) { $reason = "FargoWork $Phase for $Target did not complete (exit $ExitCode)." }
    return $reason
}

function Get-SafeClientSummary([object]$Payload) {
    $summary = @{}
    foreach ($name in @('manual', 'codex', 'cursor', 'workbuddy', 'claude-code')) {
        $client = if ($Payload.clients) { $Payload.clients.$name } else { $null }
        if (-not $client) { continue }
        $record = @{}
        foreach ($field in @('detected', 'registered', 'needs_user_action', 'mutation_may_have_happened')) {
            if ($client.$field -is [bool]) { $record[$field] = $client.$field }
        }
        $record.trusted = if ($client.trusted -is [bool]) { $client.trusted } else { 'unknown' }
        if ($client.registration -cin @('not_detected', 'not_registered', 'conflict', 'registration_missing',
                'registration_unverified', 'official-cli-error', 'official-cli-failed', 'config_unreadable',
                'official-codex-cli', 'official-cursor-user-json', 'official-claude-code-user', 'official-codebuddy-user')) {
            $record.registration = $client.registration
        }
        if ($client.reason) { $record.reason = Get-SafeClientFailure $Payload $name 'client setup' 3 }
        if ($client.skill) {
            $skill = @{}
            foreach ($field in @('installed', 'managed', 'modified', 'needs_user_action')) {
                if ($client.skill.$field -is [bool]) { $skill[$field] = $client.skill.$field }
            }
            if ($client.skill.status -cin @('ready', 'missing', 'modified', 'unavailable', 'manual_import_required')) { $skill.status = $client.skill.status }
            $record.skill = $skill
        }
        $summary[$name] = $record
    }
    return $summary
}

function Read-Checksums([string]$Path) {
    $records = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -notmatch '^([0-9a-f]{64})  ([^\/\:]+)$') { throw 'Invalid SHA256SUMS line' }
        $name = $Matches[2]
        if ($name -in @('SHA256SUMS', 'release-manifest.json') -or $records.ContainsKey($name)) { throw 'Invalid or duplicate checksum subject' }
        $records[$name] = $Matches[1]
    }
    if ($records.Count -eq 0) { throw 'SHA256SUMS is empty' }
    return $records
}

function Assert-Checksum([string]$Path, [string]$Expected) {
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Expected) { throw '[artifact_invalid] A release component failed SHA-256 verification; employee state was not changed.' }
}

function Assert-SafeZip([string]$ZipPath) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            $parts = $name.Split('/')
            if ([string]::IsNullOrWhiteSpace($name) -or [System.IO.Path]::IsPathRooted($name) -or $parts -contains '..' -or $parts -contains '.' -or $name.Contains([char]0) -or $name.Contains(':')) { throw "Unsafe ZIP path: $name" }
            foreach ($part in $parts) {
                if ($part.EndsWith('.') -or $part.EndsWith(' ') -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw "Unsafe Windows ZIP path: $name" }
            }
            $mode = ($entry.ExternalAttributes -shr 16) -band 0xF000
            if ($mode -eq 0xA000) { throw "ZIP symlink is not allowed: $name" }
        }
    } finally { $archive.Dispose() }
}

function Expand-SafeZip([string]$ZipPath, [string]$Destination) {
    Assert-SafeZip $ZipPath
    [System.IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $Destination)
}

function Download-OrUseLocal([string]$Name, [string]$LocalDir, [string]$BaseUrl, [string]$TempDir) {
    if ($LocalDir) {
        $candidate = Join-Path (Resolve-Path -LiteralPath $LocalDir) $Name
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "Local artifact is missing: $Name" }
        return (Resolve-Path -LiteralPath $candidate).Path
    }
    if (-not $BaseUrl) { throw 'Remote Release is unavailable: pass -LocalArtifactDir or set -ReleaseBaseUrl; no public URL is claimed by this checkout.' }
    if ($BaseUrl -match 'example\.invalid') { throw 'Remote Release URL is a placeholder and is unavailable.' }
    if ($BaseUrl -notmatch '^https://') { throw 'Remote Release URL must use HTTPS.' }
    $destination = Join-Path $TempDir $Name
    $uri = $BaseUrl.TrimEnd('/') + '/' + [uri]::EscapeDataString($Name)
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Invoke-WebRequest -Uri $uri -OutFile $destination
            return $destination
        } catch {
            if (Test-Path -LiteralPath $destination) {
                Remove-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
            }
            if ($attempt -eq 3) { throw }
            Start-Sleep -Seconds $attempt
        }
    }
}

function Assert-NoReparsePointChain([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($full)
    if (-not $root) { throw "Path has no filesystem root: $Path" }
    $cursor = $root
    $relative = $full.Substring($root.Length).Trim([char[]]@([char]92, [char]47))
    foreach ($part in $relative.Split([char[]]@([char]92, [char]47), [StringSplitOptions]::RemoveEmptyEntries)) {
        $cursor = Join-Path $cursor $part
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing a FargoWork path that crosses a reparse point: $cursor"
            }
        }
    }
}

function Assert-UnderInstallRoot([string]$Path) {
    $root = [System.IO.Path]::GetFullPath($script:installRoot).TrimEnd([char[]]@([char]92, [char]47))
    $full = [System.IO.Path]::GetFullPath($Path)
    if (-not $full.Equals($root, [StringComparison]::OrdinalIgnoreCase) -and -not $full.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing a FargoWork path outside the employee install root: $full"
    }
    Assert-NoReparsePointChain $full
}

function Assert-NoReparsePointTree([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "Expected a FargoWork directory: $Path" }
    Assert-NoReparsePointChain $Path
    foreach ($item in @(Get-ChildItem -LiteralPath $Path -Force -Recurse -ErrorAction Stop)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing a FargoWork tree that contains a reparse point: $($item.FullName)"
        }
    }
}

function Read-ExactMarker([string]$Path) {
    return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
}

function Write-ExactMarker([string]$Path, [string]$Value) {
    [IO.File]::WriteAllText($Path, $Value, [Text.UTF8Encoding]::new($false))
}

function Assert-OwnedDirectory([string]$Path, [string]$MarkerName = '.fargowork-owner', [string]$MarkerValue = 'fargowork-employee-v1') {
    Assert-UnderInstallRoot $Path
    Assert-NoReparsePointTree $Path
    $marker = Join-Path $Path $MarkerName
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or (Read-ExactMarker $marker) -cne $MarkerValue) {
        throw "Refusing to replace a FargoWork directory without its exact ownership marker: $Path"
    }
}

function Assert-StageDirectory {
    if (-not $script:stage -or -not (Test-Path -LiteralPath $script:stage -PathType Container)) {
        throw 'The FargoWork update stage is missing.'
    }
    Assert-UnderInstallRoot $script:stage
    Assert-NoReparsePointTree $script:stage
    $marker = Join-Path $script:stage '.fargowork-stage-owner'
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or (Read-ExactMarker $marker) -cne $script:stageToken) {
        throw 'Cannot verify ownership of the FargoWork update stage.'
    }
}

function Set-MoveState([string]$Role, [bool]$Value) {
    switch ($Role) {
        'old-bin' { $script:oldBinMoved = $Value }
        'old-plugin' { $script:oldPluginMoved = $Value }
        'new-bin' { $script:newBinInstalled = $Value }
        'new-plugin' { $script:newPluginInstalled = $Value }
        default { throw "Unknown FargoWork move role: $Role" }
    }
}

function Invoke-TrackedMove([string]$Source, [string]$Destination, [string]$Role) {
    Assert-UnderInstallRoot $Source
    Assert-UnderInstallRoot $Destination
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "FargoWork move source is missing: $Source" }
    if (Test-Path -LiteralPath $Destination) { throw "FargoWork move destination is already occupied: $Destination" }
    try {
        Move-Item -LiteralPath $Source -Destination $Destination
        Set-MoveState $Role $true
    } catch {
        $sourceExists = Test-Path -LiteralPath $Source
        $destinationExists = Test-Path -LiteralPath $Destination
        if (-not $sourceExists -and $destinationExists) {
            Set-MoveState $Role $true
        } elseif ($sourceExists -and -not $destinationExists) {
            Set-MoveState $Role $false
        } else {
            $script:ambiguousTransition = $true
        }
        throw
    }
}

function Restore-BackupDirectory([string]$Backup, [string]$Destination, [string]$Kind) {
    Assert-OwnedDirectory $Backup
    Assert-UnderInstallRoot $Destination
    if (Test-Path -LiteralPath $Destination) { throw "Cannot restore the previous FargoWork $Kind because its destination is occupied: $Destination" }
    try {
        Move-Item -LiteralPath $Backup -Destination $Destination
    } catch {
        if ((Test-Path -LiteralPath $Backup) -or -not (Test-Path -LiteralPath $Destination)) { throw }
    }
    if (-not (Test-Path -LiteralPath $Destination -PathType Container)) { throw "The previous FargoWork $Kind was not restored." }
    Assert-OwnedDirectory $Destination
}

function Restore-EmployeeInstall {
    if ($script:ambiguousTransition) { throw 'A FargoWork directory move ended in an ambiguous state; the staged backup was retained without deleting either copy.' }
    Assert-StageDirectory
    if ($script:newPluginInstalled -and (Test-Path -LiteralPath $script:pluginDest)) {
        Assert-OwnedDirectory $script:pluginDest
        Remove-Item -LiteralPath $script:pluginDest -Recurse -Force
        $script:newPluginInstalled = $false
    }
    if ($script:newBinInstalled -and (Test-Path -LiteralPath $script:binDir)) {
        Assert-OwnedDirectory $script:binDir
        Remove-Item -LiteralPath $script:binDir -Recurse -Force
        $script:newBinInstalled = $false
    }
    $backupRoot = Join-Path $script:stage 'backup'
    if ($script:oldBinMoved) {
        Restore-BackupDirectory (Join-Path $backupRoot 'bin') $script:binDir 'client'
        $script:oldBinMoved = $false
    }
    if ($script:oldPluginMoved) {
        $parent = Split-Path -Parent $script:pluginDest
        Assert-UnderInstallRoot $parent
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent | Out-Null }
        Assert-UnderInstallRoot $parent
        Restore-BackupDirectory (Join-Path $backupRoot 'plugin') $script:pluginDest 'plugin'
        $script:oldPluginMoved = $false
    }
}

function Remove-VerifiedStage {
    if (-not $script:stage -or -not (Test-Path -LiteralPath $script:stage)) { return }
    Assert-StageDirectory
    Remove-Item -LiteralPath $script:stage -Recurse -Force
}

$script:installRoot = $null
$script:binDir = $null
$script:pluginDest = $null
$script:stage = $null
$script:stageToken = $null
$script:oldBinMoved = $false
$script:oldPluginMoved = $false
$script:newBinInstalled = $false
$script:newPluginInstalled = $false
$script:ambiguousTransition = $false
$script:recoveryPath = $null
$script:recoveryError = $null
$script:tempDir = $null
$script:retainInstall = $false
$script:targetResults = [System.Collections.Generic.List[object]]::new()
$script:identityVerified = $false
$script:connected = $null
$script:manualRegistration = $null
$script:skillPath = $null
$script:diagnosticComponent = 'installer'
$script:diagnosticUnavailable = $false
$script:attemptId = $null
$script:diagnosticDirectory = $null
$script:resolvedCodexPath = $null
$script:installationPhase = 'preflight'
$script:profileResult = $null
$script:profilePendingReset = $false
$script:authenticationErrorCode = $null

try {
    $selectedTargets = @(Resolve-Targets $Target)
    Resolve-InstallationAttempt
    if ($PSBoundParameters.ContainsKey('OpenBrowser') -and -not $Login) { throw '-OpenBrowser requires -Login.' }
    if (-not $ServiceIssuer) { throw 'Pass -ServiceIssuer with the real HTTPS FargoWork service address supplied by your administrator.' }
    if (-not $LocalArtifactDir -and -not $ReleaseBaseUrl) { throw 'Pass -LocalArtifactDir for a verified local candidate or -ReleaseBaseUrl for an explicitly published release.' }
    if ($ServiceIssuer -notmatch '^https://[^/]+/?$') { throw 'ServiceIssuer must be the HTTPS FargoWork issuer origin supplied by your administrator.' }
    $platformName = 'windows'
    $archName = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { throw '32-bit Windows is not supported by this release.' }
    Invoke-HostPreflight $selectedTargets
    Write-InstallationDiagnostic 'installation_started' 'start' 'started'
    Write-InstallationDiagnostic 'preflight_result' 'preflight' 'succeeded'
    $script:installationPhase = 'download'

    $tempBase = [System.IO.Path]::GetTempPath()
    Assert-NoReparsePointChain $tempBase
    $script:tempDir = Join-Path $tempBase ("fargowork-install-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $script:tempDir | Out-Null
    Assert-NoReparsePointChain $script:tempDir

    $checksumPath = Download-OrUseLocal 'SHA256SUMS' $LocalArtifactDir $ReleaseBaseUrl $script:tempDir
    $checksums = Read-Checksums $checksumPath
    $cliName = "fargowork-cli-v$Version-$platformName-$archName.zip"
    $bridgeName = "fargowork-bridge-v$Version-$platformName-$archName.zip"
    $pluginName = "fargowork-agent-plugin-v$Version-$platformName-$archName.zip"
    foreach ($name in @($cliName, $bridgeName, $pluginName)) {
        if (-not $checksums.ContainsKey($name)) { throw "SHA256SUMS does not declare $name" }
    }
    $cliZip = Download-OrUseLocal $cliName $LocalArtifactDir $ReleaseBaseUrl $script:tempDir
    $bridgeZip = Download-OrUseLocal $bridgeName $LocalArtifactDir $ReleaseBaseUrl $script:tempDir
    $pluginZip = Download-OrUseLocal $pluginName $LocalArtifactDir $ReleaseBaseUrl $script:tempDir
    $script:installationPhase = 'verify'
    Assert-Checksum $cliZip $checksums[$cliName]
    Assert-Checksum $bridgeZip $checksums[$bridgeName]
    Assert-Checksum $pluginZip $checksums[$pluginName]
    Write-InstallationDiagnostic 'package_verified' 'verify' 'succeeded'
    $extractRoot = Join-Path $script:tempDir 'extract'
    $cliRoot = Join-Path $extractRoot 'cli'
    $pluginRoot = Join-Path $extractRoot 'plugin'
    New-Item -ItemType Directory -Path $cliRoot, $pluginRoot | Out-Null
    Expand-SafeZip $cliZip $cliRoot
    Expand-SafeZip $pluginZip $pluginRoot
    $exe = Get-ChildItem -LiteralPath $cliRoot -Filter 'fargowork.exe' -File -Recurse | Select-Object -First 1
    $pluginSource = Join-Path $pluginRoot 'fargowork'
    if (-not $exe -or -not (Test-Path -LiteralPath $pluginSource -PathType Container)) { throw '[incomplete_install] Verified artifact is missing the native executable or Plugin directory.' }
    foreach ($requiredPath in @('plugin.json', 'mcp.json', 'bin\fargowork.cmd', 'skills\fargowork-employee\SKILL.md')) {
        if (-not (Test-Path -LiteralPath (Join-Path $pluginSource $requiredPath) -PathType Leaf)) { throw '[incomplete_install] Verified artifact lacks a required Plugin, launcher or core Skill file; employee state was not changed.' }
    }
    $pluginManifest = Get-Content -LiteralPath (Join-Path $pluginSource 'plugin.json') -Raw | ConvertFrom-Json
    if ($pluginManifest.name -ne 'fargowork-employee' -or $pluginManifest.version -ne $Version) { throw '[artifact_invalid] Plugin identity or version does not match this employee candidate.' }
    if ($DryRun) {
        Write-InstallationDiagnostic 'installation_finished' 'finish' 'succeeded' '' 0
        Emit-Result @{ event = 'dry_run'; status = 'verified'; installed = $false; connected = $null; identity_verified = $false; trusted = 'unknown'; needs_user_action = $true; selected_targets = $selectedTargets; login_requested = [bool]$Login; employee_configuration_changed = $false; temporary_downloads = $true; diagnostics_written = -not $script:diagnosticUnavailable; message = 'Host prerequisites and local/remote artifacts verified. Temporary downloads and bounded diagnostics may be written; employee configuration, credentials and host registration are unchanged.' }
        exit 0
    }
    $script:installationPhase = 'stage'

    # The employee profile is deliberately below the shared FargoWork root.
    # No operation in this installer targets the developer plugin or vault.
    $appData = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $env:USERPROFILE 'AppData\Roaming' }
    if (-not [System.IO.Path]::IsPathRooted($appData)) { throw 'APPDATA must be an absolute local path.' }
    $appData = [System.IO.Path]::GetFullPath($appData)
    Assert-NoReparsePointChain $appData
    $configBase = Join-Path $appData 'FargoWork'
    $script:installRoot = Join-Path $configBase 'employee'
    $script:binDir = Join-Path $script:installRoot 'bin'
    $script:pluginDest = Join-Path $script:installRoot 'plugin\fargowork-employee'
    $rootMarker = Join-Path $script:installRoot '.fargowork-employee-owner'
    Assert-NoReparsePointChain $configBase
    if (Test-Path -LiteralPath $configBase) {
        if (-not (Test-Path -LiteralPath $configBase -PathType Container)) { throw 'The FargoWork profile parent exists but is not a directory.' }
    } else {
        New-Item -ItemType Directory -Path $configBase | Out-Null
        Assert-NoReparsePointChain $configBase
    }
    Assert-NoReparsePointChain $script:installRoot
    if ((Test-Path -LiteralPath $script:installRoot) -and -not (Test-Path -LiteralPath $script:installRoot -PathType Container)) {
        throw '[incomplete_install] The employee profile path is not a directory; it was preserved.'
    }
    if (-not (Test-Path -LiteralPath $script:installRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $script:installRoot | Out-Null
        Assert-NoReparsePointChain $script:installRoot
    }
    if (Test-Path -LiteralPath $rootMarker) {
        Assert-NoReparsePointChain $rootMarker
        if (-not (Test-Path -LiteralPath $rootMarker -PathType Leaf) -or (Read-ExactMarker $rootMarker) -cne 'fargowork-employee-v1') {
            throw 'Refusing an employee profile with an invalid ownership marker.'
        }
    } else {
        if (@(Get-ChildItem -LiteralPath $script:installRoot -Force).Count -gt 0) {
            throw 'Refusing a non-empty employee profile without its FargoWork ownership marker.'
        }
        Write-ExactMarker $rootMarker 'fargowork-employee-v1'
    }

    Assert-NoReparsePointChain $script:binDir
    if (Test-Path -LiteralPath $script:binDir) { Assert-OwnedDirectory $script:binDir }
    $pluginParent = Split-Path -Parent $script:pluginDest
    Assert-NoReparsePointChain $pluginParent
    if ((Test-Path -LiteralPath $pluginParent) -and -not (Test-Path -LiteralPath $pluginParent -PathType Container)) {
        throw 'The employee plugin parent exists but is not a directory.'
    }
    Assert-NoReparsePointChain $script:pluginDest
    if (Test-Path -LiteralPath $script:pluginDest) { Assert-OwnedDirectory $script:pluginDest }

    $script:stageToken = [guid]::NewGuid().ToString('N')
    $script:stage = Join-Path $script:installRoot ('.fargowork-stage-' + $script:stageToken)
    if (Test-Path -LiteralPath $script:stage) { throw 'The generated FargoWork stage path already exists.' }
    New-Item -ItemType Directory -Path $script:stage | Out-Null
    Assert-UnderInstallRoot $script:stage
    Write-ExactMarker (Join-Path $script:stage '.fargowork-stage-owner') $script:stageToken
    $stageNew = Join-Path $script:stage 'new'
    $stageBin = Join-Path $stageNew 'bin'
    $stagePlugin = Join-Path $stageNew 'plugin'
    $backupRoot = Join-Path $script:stage 'backup'
    New-Item -ItemType Directory -Path $stageBin, $stagePlugin, $backupRoot | Out-Null
    Copy-Item -LiteralPath $exe.FullName -Destination (Join-Path $stageBin 'fargowork.exe')
    $newPlugin = Join-Path $stagePlugin 'fargowork-employee'
    Copy-Item -LiteralPath $pluginSource -Destination $newPlugin -Recurse
    New-Item -ItemType Directory -Path (Join-Path $newPlugin 'bin') -Force | Out-Null
    Copy-Item -LiteralPath $exe.FullName -Destination (Join-Path $newPlugin 'bin\fargowork.exe') -Force
    Write-ExactMarker (Join-Path $stageBin '.fargowork-owner') 'fargowork-employee-v1'
    Write-ExactMarker (Join-Path $newPlugin '.fargowork-owner') 'fargowork-employee-v1'
    Assert-StageDirectory
    Assert-OwnedDirectory $stageBin
    Assert-OwnedDirectory $newPlugin
    Write-InstallationDiagnostic 'files_staged' 'stage' 'succeeded'

    $backupBin = Join-Path $backupRoot 'bin'
    $backupPlugin = Join-Path $backupRoot 'plugin'
    if (Test-Path -LiteralPath $script:binDir) {
        Assert-OwnedDirectory $script:binDir
        Invoke-TrackedMove $script:binDir $backupBin 'old-bin'
    }
    if (Test-Path -LiteralPath $script:pluginDest) {
        Assert-OwnedDirectory $script:pluginDest
        Invoke-TrackedMove $script:pluginDest $backupPlugin 'old-plugin'
    }
    Invoke-TrackedMove $stageBin $script:binDir 'new-bin'
    if (-not (Test-Path -LiteralPath $pluginParent -PathType Container)) {
        New-Item -ItemType Directory -Path $pluginParent | Out-Null
    }
    Assert-NoReparsePointChain $pluginParent
    Invoke-TrackedMove $newPlugin $script:pluginDest 'new-plugin'

    $installedExe = Join-Path $script:binDir 'fargowork.exe'
    $script:installationPhase = 'register'
    $successfulTargets = 0
    foreach ($selectedTarget in $selectedTargets) {
        $result = @{ target = $selectedTarget; status = 'error'; installed = $false; connected = $null; identity_verified = $false; trusted = 'unknown'; needs_user_action = $true }
        $script:targetResults.Add($result)
        try {
            $installArguments = @('install', '--target', $selectedTarget, '--issuer', $ServiceIssuer, '--attempt-id', $script:attemptId, '--output', 'jsonl')
            if ($selectedTarget -eq 'codex' -and $script:resolvedCodexPath) { $installArguments += @('--codex-path', $script:resolvedCodexPath) }
            $installation = Invoke-EmployeeCli $installedExe $installArguments
            $result.install_exit_code = $installation.ExitCode
            $clientStates = @()
            if ($installation.Payload.clients -is [System.Collections.IDictionary]) {
                $clientStates = @($installation.Payload.clients.Values)
            } elseif ($installation.Payload.clients) {
                $clientStates = @($installation.Payload.clients.PSObject.Properties | ForEach-Object { $_.Value })
            }
            $hasRegistrationEvidence = @($clientStates | Where-Object { $_.registered -eq $true }).Count -gt 0
            $hasMutationEvidence = $installation.Payload.mutation_may_have_happened -eq $true -or @($clientStates | Where-Object { $_.mutation_may_have_happened -eq $true }).Count -gt 0
            if ($installation.Payload.code -eq 'registration_rollback_required' -or $hasRegistrationEvidence -or $hasMutationEvidence) {
                # A failed host operation may still reference these files. Keep
                # the installed package and report manual recovery explicitly.
                $script:retainInstall = $true
                $result.clients = Get-SafeClientSummary $installation.Payload
                if ($installation.ExitCode -ne 0) {
                    $result.requires_manual_recovery = $true
                    $result.mutation_may_have_happened = $hasMutationEvidence
                    $result.registration_evidence = $hasRegistrationEvidence
                }
            }
            if ($installation.ExitCode -ne 0 -or -not $installation.Payload.installed -or $installation.Payload.event -ne 'installed') {
                if ($installation.Payload.code) { $result.code = $installation.Payload.code }
                $result.next_action = if ($hasRegistrationEvidence -or $hasMutationEvidence) { 'Review the reported registration state. Do not retry or manually edit configuration until the service owner confirms recovery.' } else { 'Stop and send the attempt ID, safe result and diagnostic export to the service owner. Do not manually stage files or try alternate installation commands.' }
                Write-InstallationDiagnostic 'client_registration_result' 'register' 'failed' 'registration_failed' $installation.ExitCode
                throw (Get-SafeClientFailure $installation.Payload $selectedTarget 'installation' $installation.ExitCode)
            }
            $result.installed = $true
            # Registration may already reference this executable. A later
            # diagnostic or authentication failure must not remove it.
            $script:retainInstall = $true
            Write-InstallationDiagnostic 'client_registration_result' 'register' 'succeeded' '' $installation.ExitCode
            $doctorArguments = @('doctor', '--target', $selectedTarget, '--attempt-id', $script:attemptId, '--output', 'jsonl')
            if ($selectedTarget -eq 'codex' -and $script:resolvedCodexPath) { $doctorArguments += @('--codex-path', $script:resolvedCodexPath) }
            $diagnostic = Invoke-EmployeeCli $installedExe $doctorArguments
            $result.doctor_exit_code = $diagnostic.ExitCode
            if ($diagnostic.ExitCode -notin @(0, 3) -or $diagnostic.Payload.event -ne 'doctor' -or -not $diagnostic.Payload.installed) {
                if ($diagnostic.Payload.code) { $result.code = $diagnostic.Payload.code }
                throw (Get-SafeClientFailure $diagnostic.Payload $selectedTarget 'diagnostic' $diagnostic.ExitCode)
            }
            $result.status = if ($diagnostic.ExitCode -eq 3) { 'needs_user_action' } else { 'installed' }
            $result.trusted = $diagnostic.Payload.trusted
            $result.clients = Get-SafeClientSummary $diagnostic.Payload
            if ($installation.Payload.manual_mcp_registration) { $script:manualRegistration = $installation.Payload.manual_mcp_registration }
            if ($installation.Payload.skill_path) { $script:skillPath = $installation.Payload.skill_path }
            $successfulTargets++
        } catch {
            $result.message = $_.Exception.Message
            $result.status = 'error'
        }
    }
    # Each host adapter owns its exact configuration transaction. Keep the new
    # employee executable when another host already installed successfully.
    $script:retainInstall = $script:retainInstall -or $successfulTargets -gt 0
    if ($successfulTargets -ne $selectedTargets.Count) {
        if (@($script:targetResults | Where-Object { $_.requires_manual_recovery }).Count -gt 0) {
            throw 'One or more host registrations may have changed. Installed files were retained; review the per-target recovery results before retrying.'
        }
        throw 'One or more FargoWork targets failed; see the per-target results.'
    }

    if ($Login) {
        $script:installationPhase = 'login'
        $authentication = Invoke-EmployeeCli $installedExe @('login', '--browser', $OpenBrowser, '--attempt-id', $script:attemptId, '--output', 'jsonl')
        $script:connected = $false
        if ($authentication.ExitCode -ne 0 -or $authentication.Payload.event -ne 'logged_in' -or $authentication.Payload.connected -ne $true) {
            $script:authenticationErrorCode = $authentication.Payload.code
            throw "FargoWork login failed (exit $($authentication.ExitCode)); installed files and personal state were retained."
        }
        if ($authentication.Payload.profile) { $script:profileResult = $authentication.Payload.profile }
        $script:profilePendingReset = $authentication.Payload.profile_pending_reset -eq $true
        $verifiedTargets = 0
        $script:installationPhase = 'identity'
        foreach ($result in $script:targetResults) {
            $statusArguments = @('status', '--target', $result.target, '--attempt-id', $script:attemptId, '--output', 'jsonl')
            if ($result.target -eq 'codex' -and $script:resolvedCodexPath) { $statusArguments += @('--codex-path', $script:resolvedCodexPath) }
            $verification = Invoke-EmployeeCli $installedExe $statusArguments
            $result.status_exit_code = $verification.ExitCode
            $result.identity_verified = $verification.Payload.identity_verified -eq $true
            $result.connected = $verification.Payload.connected -eq $true -and $result.identity_verified
            if ($verification.ExitCode -notin @(0, 3) -or -not $result.connected) {
                $result.status = 'identity_verification_failed'
                $result.needs_user_action = $true
                continue
            }
            $verifiedTargets++
            $result.needs_user_action = [bool]$verification.Payload.needs_user_action
            $result.trusted = $verification.Payload.trusted
            $result.clients = Get-SafeClientSummary $verification.Payload
            if ($verification.Payload.profile) { $result.profile = $verification.Payload.profile; $script:profileResult = $verification.Payload.profile }
            if ($verification.Payload.profile_pending_reset -eq $true) { $result.profile_pending_reset = $true; $script:profilePendingReset = $true }
            $result.status = if ($result.needs_user_action) { 'needs_user_action' } else { 'ready' }
        }
        $script:identityVerified = $verifiedTargets -eq $selectedTargets.Count
        $script:connected = $script:identityVerified
        if (-not $script:identityVerified) { throw 'FargoWork was installed, but authenticated identity verification failed for one or more targets.' }
    }

    $needsAction = -not $script:identityVerified -or @($script:targetResults | Where-Object { $_.needs_user_action }).Count -gt 0
    $message = "FargoWork installed for $($selectedTargets -join ', ')."
    $cleanupPending = $false
    try { Remove-VerifiedStage } catch {
        $cleanupPending = $true
        $script:recoveryPath = $script:stage
        $script:recoveryError = "The update succeeded, but old recovery material could not be cleaned: $($_.Exception.Message)"
    }
    $payload = @{ event = 'installed'; status = if ($needsAction) { 'needs_user_action' } else { 'ready' }; installed = $true; connected = $script:connected; identity_verified = $script:identityVerified; trusted = if (@($script:targetResults | Where-Object { $_.trusted -ne $true }).Count -eq 0) { $true } else { 'unknown' }; needs_user_action = $needsAction; plugin_dir = $script:pluginDest; targets = $script:targetResults.ToArray(); manual_mcp_registration = $script:manualRegistration; skill_path = $script:skillPath; login_command = "& '$($installedExe.Replace("'", "''"))' login --browser always"; message = $message }
    if ($script:profileResult) { $payload.profile = $script:profileResult }
    $payload.profile_pending_reset = $script:profilePendingReset
    if ($cleanupPending) { $payload.recovery_path = $script:recoveryPath; $payload.message = $script:recoveryError }
    Write-InstallationDiagnostic 'installation_finished' 'finish' 'succeeded' '' 0
    Emit-Result $payload
    exit 0
} catch {
    $mainError = $_.Exception.Message
    $failureCode = Get-InstallationErrorCode $mainError
    Write-InstallationDiagnostic 'installation_finished' $script:installationPhase 'failed' $failureCode 4
    if ($script:stage -and (Test-Path -LiteralPath $script:stage) -and -not $script:recoveryPath) {
        try {
            if (-not $script:retainInstall -and ($script:oldBinMoved -or $script:oldPluginMoved -or $script:newBinInstalled -or $script:newPluginInstalled -or $script:ambiguousTransition)) {
                Restore-EmployeeInstall
            }
            Remove-VerifiedStage
        } catch {
            $script:recoveryPath = $script:stage
            $script:recoveryError = $_.Exception.Message
        }
    }
    if (-not $script:retainInstall -and -not $script:recoveryPath) {
        foreach ($result in $script:targetResults) { $result.installed = $false; $result.rolled_back = $true }
    } elseif ($script:recoveryPath) {
        foreach ($result in $script:targetResults) { $result.rollback_status = 'recovery_required' }
    }
    $payload = @{ event = 'error'; status = if ($script:retainInstall) { 'installed_with_errors' } else { 'error' }; installed = $script:retainInstall; connected = $script:connected; identity_verified = $script:identityVerified; trusted = 'unknown'; needs_user_action = $true; targets = $script:targetResults.ToArray(); manual_mcp_registration = $script:manualRegistration; skill_path = $script:skillPath; code = if ($script:recoveryPath) { 'install_failed_recovery_required' } elseif ($script:retainInstall) { 'post_install_failed' } else { 'install_failed' }; message = $mainError }
    $payload.phase = $script:installationPhase
    $payload.error_code = $failureCode
    $payload.next_action = 'Stop and provide this attempt ID and safe diagnostic export to the service owner. Do not guess paths, manually stage files, modify other products or repeat installation.'
    if ($script:authenticationErrorCode) { $payload.authentication_error_code = $script:authenticationErrorCode }
    if ($script:recoveryPath) {
        $payload.recovery_path = $script:recoveryPath
        $payload.recovery_error = $script:recoveryError
    }
    Emit-Result $payload
    exit 4
} finally {
    if ($script:tempDir -and (Test-Path -LiteralPath $script:tempDir)) {
        Remove-Item -LiteralPath $script:tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
