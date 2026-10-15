[CmdletBinding()]
param(
    [string]$Version = '1.4.2',
    [string]$ServiceIssuer,
    [string]$LocalArtifactDir,
    [string]$ReleaseBaseUrl,
    [switch]$Login,
    [ValidateSet('auto', 'always', 'never')]
    [string]$OpenBrowser = 'auto',
    [switch]$DryRun,
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
                'skill_install_result', 'installation_finished',
                'launcher_started', 'launcher_finished')
    $phases = @('start', 'preflight', 'download', 'verify', 'stage', 'install', 'login', 'identity', 'finish', 'cleanup')
    $outcomes = @('started', 'succeeded', 'failed', 'rejected', 'unavailable', 'skipped', 'pending', 'not_attempted')
    $errors = @('attempt_id_invalid', 'service_issuer_invalid', 'artifact_invalid', 'installation_failed', 'skill_install_failed', 'login_failed',
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

function Get-InstallationErrorCode([string]$Message, [string]$Fallback = 'installation_failed') {
    if ($Message -match '^\[([a-z][a-z0-9_]+)\]') { return $Matches[1] }
    return $Fallback
}

function Resolve-ServiceIssuer([string]$Value) {
    if (-not $Value -or $Value -match '[\s\\]') { throw '[service_issuer_invalid] Select one HTTPS FargoWork endpoint or an HTTP loopback endpoint.' }
    try { $uri = [Uri]$Value } catch { throw '[service_issuer_invalid] Select one HTTPS FargoWork endpoint or an HTTP loopback endpoint.' }
    if (-not $uri.IsAbsoluteUri -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -notin @('', '/') -or
        ($uri.Scheme -cne 'https' -and -not ($uri.Scheme -ceq 'http' -and $uri.IsLoopback))) {
        throw '[service_issuer_invalid] Select one HTTPS FargoWork endpoint or an HTTP loopback endpoint.'
    }
    return $uri.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
}

function Emit-Result([hashtable]$Payload) {
    $Payload.attempt_id = $script:attemptId
    $Payload.diagnostic_log_dir = $script:diagnosticDirectory
    $Payload.diagnostic_available = -not $script:diagnosticUnavailable
    # One terminal machine-readable result is the default contract. Support
    # diagnostics remain in the bounded log rather than becoming an Agent report.
    $Payload | ConvertTo-Json -Compress -Depth 10
}

function Invoke-EmployeeCli([string]$Exe, [string[]]$Arguments) {
    # Keep identity and diagnostic responses in memory. Browser guidance is the
    # only progress output; an explicit browser=never needs its functional URL.
    $capture = @{ payload = $null }
    $browserPrompted = $false
    $previousErrorPreference = $ErrorActionPreference
    try {
        # Windows PowerShell converts native stderr into ErrorRecords. Keep
        # those inside the filter rather than terminating with raw stderr.
        $ErrorActionPreference = 'Continue'
        & $Exe @Arguments 2>&1 | ForEach-Object {
        try {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { return }
            $event = [string]$_ | ConvertFrom-Json -ErrorAction Stop
            if ($event.event -eq 'login_authorization_url') {
                if ($OpenBrowser -eq 'never') {
                    # This is an interactive authorization link, never a log
                    # event or part of the final installation result.
                    Write-Host (@{ event = 'login_authorization_url'; url = [string]$event.url; attempt_id = $script:attemptId } | ConvertTo-Json -Compress -Depth 3)
                } elseif (-not $browserPrompted) {
                    Write-Host 'Complete DingTalk authorization in the opened browser.'
                    $browserPrompted = $true
                }
            } elseif ($event.event -in @('installed', 'doctor', 'logged_in', 'status', 'error')) {
                $capture.payload = $event
            } elseif ($event.event -in @('login_browser_opened', 'login_started') -and $OpenBrowser -ne 'never' -and -not $browserPrompted) {
                Write-Host 'Complete DingTalk authorization in the opened browser.'
                $browserPrompted = $true
            }
        } catch {
            # Unexpected native diagnostics are not copied into structured logs.
        }
        }
    } finally { $ErrorActionPreference = $previousErrorPreference }
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Payload = $capture.payload }
}

function Get-SafeInstallFailure([object]$Payload, [string]$Phase, [int]$ExitCode) {
    $code = [string]$Payload.error_code
    $fixed = @{
        service_issuer_invalid = 'The selected service endpoint is invalid; no alternate endpoint was tried.'
        skill_missing = 'The employee package is incomplete; all five workflow Skills are required.'
        modified_skill_preserved = 'An installed Skill has local changes; all existing Skill files were preserved.'
        ownership_conflict = 'An existing unowned path was preserved; installation stopped.'
        unsafe_path = 'A linked or unsafe installation path was rejected.'
        configuration_required = 'Select the FargoWork service endpoint supplied by your administrator.'
        invalid_config = 'The selected FargoWork service endpoint or stored configuration is invalid.'
        install_failed_recovery_required = 'Skill installation failed; review the preserved recovery files before retrying.'
    }
    if ($code -and $fixed.ContainsKey($code)) { return $fixed[$code] }
    return "FargoWork $Phase did not complete (exit $ExitCode)."
}

function Get-SafeLegacyMigration([object]$Payload) {
    $summary = @{}
    if (-not $Payload.legacy_migration) { return $summary }
    foreach ($legacyName in @('cursor', 'codex', 'claude-code', 'workbuddy')) {
        $legacy = $Payload.legacy_migration.$legacyName
        if ($legacy.status -cin @('absent', 'removed', 'preserved', 'unverified')) {
            $summary[$legacyName] = @{ status = $legacy.status; needs_user_action = $legacy.needs_user_action -eq $true }
        }
    }
    return $summary
}

function Test-LegacyBridgeFilesProven([string]$PluginDirectory) {
    if (-not (Test-Path -LiteralPath $PluginDirectory -PathType Container)) { return $true }
    $retired = @('mcp.json', 'bin/fargowork.cmd', 'bin/fargowork.exe', 'bin/fargowork')
    $present = @($retired | Where-Object { Test-Path -LiteralPath (Join-Path $PluginDirectory $_) })
    if ($present.Count -eq 0) { return $true }
    $manifestPath = Join-Path $PluginDirectory 'PACKAGE-MANIFEST.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $false }
    try {
        Assert-NoReparsePointChain $manifestPath
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        foreach ($relative in $present) {
            $subject = Join-Path $PluginDirectory $relative
            Assert-NoReparsePointChain $subject
            $entry = @($manifest.files | Where-Object { $_.path -ceq $relative })
            if ($entry.Count -ne 1 -or $entry[0].sha256 -cnotmatch '^[0-9a-f]{64}$' -or
                -not (Test-Path -LiteralPath $subject -PathType Leaf) -or
                (Get-FileHash -LiteralPath $subject -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry[0].sha256 -or
                (Get-Item -LiteralPath $subject).Length -ne $entry[0].size) { return $false }
        }
        return $true
    } catch { return $false }
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
$script:installResult = $null
$script:identityVerified = $false
$script:connected = $null
$script:skillPath = $null
$script:diagnosticComponent = 'installer'
$script:diagnosticUnavailable = $false
$script:attemptId = $null
$script:diagnosticDirectory = $null
$script:installationPhase = 'preflight'
$script:profileResult = $null
$script:profilePendingReset = $false
$script:authenticationErrorCode = $null
$script:failureExitCode = 4
$script:businessCliAvailable = $false
$script:legacyBridgeFilesProven = $true

try {
    Resolve-InstallationAttempt
    if ($PSBoundParameters.ContainsKey('OpenBrowser') -and -not $Login) { throw '-OpenBrowser requires -Login.' }
    $ServiceIssuer = Resolve-ServiceIssuer $ServiceIssuer
    if (-not $LocalArtifactDir -and -not $ReleaseBaseUrl) { throw 'Pass -LocalArtifactDir for a verified local candidate or -ReleaseBaseUrl for an explicitly published release.' }
    $platformName = 'windows'
    $archName = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { throw '32-bit Windows is not supported by this release.' }
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
    $pluginName = "fargowork-agent-plugin-v$Version-$platformName-$archName.zip"
    foreach ($name in @($cliName, $pluginName)) {
        if (-not $checksums.ContainsKey($name)) { throw "SHA256SUMS does not declare $name" }
    }
    $cliZip = Download-OrUseLocal $cliName $LocalArtifactDir $ReleaseBaseUrl $script:tempDir
    $pluginZip = Download-OrUseLocal $pluginName $LocalArtifactDir $ReleaseBaseUrl $script:tempDir
    $script:installationPhase = 'verify'
    Assert-Checksum $cliZip $checksums[$cliName]
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
    if (-not $exe -or -not (Test-Path -LiteralPath $pluginSource -PathType Container)) { throw '[incomplete_install] Verified artifact is missing the native executable or Skill package.' }
    $skillNames = @('fargowork-employee', 'fargowork-business-trip', 'fargowork-annual-leave', 'fargowork-procurement-request', 'fargowork-external-expense-request')
    foreach ($requiredPath in @('plugin.json') + @($skillNames | ForEach-Object { 'skills\' + $_ + '\SKILL.md' })) {
        if (-not (Test-Path -LiteralPath (Join-Path $pluginSource $requiredPath) -PathType Leaf)) { throw '[skill_missing] Verified artifact lacks one of the five required workflow Skills; employee state was not changed.' }
    }
    foreach ($retiredPath in @('mcp.json', 'bin')) {
        if (Test-Path -LiteralPath (Join-Path $pluginSource $retiredPath)) { throw '[artifact_invalid] CLI-only employee package contains retired host registration or launcher files.' }
    }
    $pluginManifest = Get-Content -LiteralPath (Join-Path $pluginSource 'plugin.json') -Raw | ConvertFrom-Json
    if ($pluginManifest.name -ne 'fargowork-employee' -or $pluginManifest.version -ne $Version) { throw '[artifact_invalid] Plugin identity or version does not match this employee candidate.' }
    if ($DryRun) {
        Write-InstallationDiagnostic 'installation_finished' 'finish' 'succeeded' '' 0
        Emit-Result @{ event = 'dry_run'; status = 'verified'; installed = $false; connected = $null; identity_verified = $false; needs_user_action = $true; service_issuer = $ServiceIssuer; required_skills = $skillNames; login_requested = [bool]$Login; employee_configuration_changed = $false; temporary_downloads = $true; diagnostics_written = -not $script:diagnosticUnavailable; connection_mode = 'official_cli'; business_cli_available = $false; tool_capability = 'not_checked'; message = 'The selected endpoint and local artifacts were verified. Temporary downloads and bounded diagnostics may be written; employee files and personal credentials are unchanged.' }
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
    $script:legacyBridgeFilesProven = Test-LegacyBridgeFilesProven $script:pluginDest

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
    $script:installationPhase = 'install'
    $script:installResult = @{ status = 'error'; installed = $false; connected = $null; identity_verified = $false; needs_user_action = $true }
    $installArguments = @('install', '--issuer', $ServiceIssuer, '--attempt-id', $script:attemptId, '--output', 'jsonl')
    $installation = Invoke-EmployeeCli $installedExe $installArguments
    $script:installResult.install_exit_code = $installation.ExitCode
    if ($installation.ExitCode -ne 0 -or $installation.Payload.event -ne 'installed' -or -not $installation.Payload.installed -or
        $installation.Payload.config.issuer -cne $ServiceIssuer -or $installation.Payload.version -cne $Version) {
        if ($installation.ExitCode -ne 0) { $script:failureExitCode = $installation.ExitCode }
        $script:installResult.error_code = [string]$installation.Payload.error_code
        $script:installResult.message = Get-SafeInstallFailure $installation.Payload 'Skill installation' $installation.ExitCode
        Write-InstallationDiagnostic 'skill_install_result' 'install' 'failed' 'skill_install_failed' $installation.ExitCode
        throw $script:installResult.message
    }
    $script:installResult.installed = $true
    $script:installResult.skills = $installation.Payload.skills
    $script:installResult.skill_paths = $installation.Payload.skill_paths
    $script:installResult.skill_cleanup_pending = $installation.Payload.skill_cleanup_pending -eq $true
    if ($script:installResult.skill_cleanup_pending -and $installation.Payload.skill_recovery_path) {
        $script:installResult.skill_recovery_path = [string]$installation.Payload.skill_recovery_path
    }
    $script:installResult.legacy_migration = Get-SafeLegacyMigration $installation.Payload
    $script:installResult.legacy_connection_review_required = $installation.Payload.legacy_connection_review_required -eq $true
    $script:installResult.business_cli_available = $installation.Payload.business_cli_available -eq $true
    $script:businessCliAvailable = $script:installResult.business_cli_available
    $script:skillPath = [string]$installation.Payload.skill_path
    # The official CLI and its five Skills are now installed. Later login or
    # diagnostics failures must keep the selected endpoint and user files.
    $script:retainInstall = $true
    Write-InstallationDiagnostic 'skill_install_result' 'install' 'succeeded' '' $installation.ExitCode

    $doctorArguments = @('doctor', '--attempt-id', $script:attemptId, '--output', 'jsonl')
    $diagnostic = Invoke-EmployeeCli $installedExe $doctorArguments
    $script:installResult.doctor_exit_code = $diagnostic.ExitCode
    if ($diagnostic.ExitCode -notin @(0, 3) -or $diagnostic.Payload.event -ne 'doctor' -or -not $diagnostic.Payload.installed -or
        $diagnostic.Payload.checks.issuer -cne $ServiceIssuer) {
        if ($diagnostic.ExitCode -ne 0) { $script:failureExitCode = $diagnostic.ExitCode }
        $script:installResult.message = Get-SafeInstallFailure $diagnostic.Payload 'Local install verification' $diagnostic.ExitCode
        throw $script:installResult.message
    }
    $script:installResult.needs_user_action = $diagnostic.Payload.needs_user_action -eq $true -or $script:installResult.legacy_connection_review_required
    $script:installResult.status = if ($script:installResult.needs_user_action) { 'needs_user_action' } else { 'installed' }

    if ($Login) {
        $script:installationPhase = 'login'
        $authentication = Invoke-EmployeeCli $installedExe @('login', '--browser', $OpenBrowser, '--attempt-id', $script:attemptId, '--output', 'jsonl')
        $script:connected = $false
        if ($authentication.ExitCode -ne 0 -or $authentication.Payload.event -ne 'logged_in' -or $authentication.Payload.connected -ne $true) {
            if ($authentication.ExitCode -ne 0) { $script:failureExitCode = $authentication.ExitCode }
            $script:authenticationErrorCode = $authentication.Payload.error_code
            throw "FargoWork login failed (exit $($authentication.ExitCode)); installed files and personal state were retained."
        }
        if ($authentication.Payload.profile) { $script:profileResult = $authentication.Payload.profile }
        $script:profilePendingReset = $authentication.Payload.profile_pending_reset -eq $true
        $script:installationPhase = 'identity'
        $verification = Invoke-EmployeeCli $installedExe @('status', '--attempt-id', $script:attemptId, '--output', 'jsonl')
        if ($verification.ExitCode -notin @(0, 3) -or $verification.Payload.event -ne 'status' -or
            $verification.Payload.connected -ne $true -or $verification.Payload.identity_verified -ne $true -or
            $verification.Payload.config.issuer -cne $ServiceIssuer) {
            if ($verification.ExitCode -ne 0) { $script:failureExitCode = $verification.ExitCode }
            throw 'FargoWork login could not verify identity on the selected service endpoint; no other endpoint was tried.'
        }
        $script:identityVerified = $true
        $script:connected = $true
        $script:installResult.connected = $true
        $script:installResult.identity_verified = $true
        $script:installResult.needs_user_action = $verification.Payload.needs_user_action -eq $true -or $script:installResult.legacy_connection_review_required
        $script:installResult.status = if ($script:installResult.needs_user_action) { 'needs_user_action' } else { 'ready' }
        if ($verification.Payload.profile) { $script:profileResult = $verification.Payload.profile }
        if ($verification.Payload.profile_pending_reset -eq $true) { $script:profilePendingReset = $true }
    }

    $needsAction = $script:installResult.needs_user_action -or -not $script:identityVerified
    $message = 'FargoWork CLI and five workflow Skills are installed for the selected service endpoint.'
    $cleanupPending = $false
    try {
        if (-not $script:legacyBridgeFilesProven) {
            $cleanupPending = $true
            $script:recoveryPath = $script:stage
            $script:recoveryError = 'Old Bridge files were modified or could not be verified; recovery material was preserved.'
        } else { Remove-VerifiedStage }
    } catch {
        $cleanupPending = $true
        $script:recoveryPath = $script:stage
        $script:recoveryError = "The update succeeded, but old recovery material could not be cleaned: $($_.Exception.Message)"
    }
    $payload = @{ event = 'installed'; status = if ($needsAction) { 'needs_user_action' } else { 'ready' }; installed = $true; connected = $script:connected; identity_verified = $script:identityVerified; needs_user_action = $needsAction; service_issuer = $ServiceIssuer; installation = $script:installResult; skill_path = $script:skillPath; skill_paths = $script:installResult.skill_paths; login_command = "& '$($installedExe.Replace("'", "''"))' login --browser always"; message = $message; connection_mode = 'official_cli'; business_cli_available = $script:businessCliAvailable; tool_capability = 'not_checked' }
    $payload.cli_path = $installedExe
    $payload.legacy_bridge_files_preserved = -not $script:legacyBridgeFilesProven
    $payload.legacy_connection_review_required = $script:installResult.legacy_connection_review_required
    $payload.legacy_migration = $script:installResult.legacy_migration
    if ($payload.legacy_connection_review_required) { $payload.needs_user_action = $true; $payload.status = 'needs_user_action'; $payload.message = 'FargoWork CLI is installed. An old unverified FargoWork connection was preserved for review.' }
    if ($script:profileResult) { $payload.profile = $script:profileResult }
    $payload.profile_pending_reset = $script:profilePendingReset
    if ($cleanupPending) { $payload.recovery_path = $script:recoveryPath; $payload.message = $script:recoveryError }
    Write-InstallationDiagnostic 'installation_finished' 'finish' 'succeeded' '' 0
    Emit-Result $payload
    exit 0
} catch {
    $mainError = $_.Exception.Message
    $failureCode = Get-InstallationErrorCode $mainError
    Write-InstallationDiagnostic 'installation_finished' $script:installationPhase 'failed' $failureCode $script:failureExitCode
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
        if ($script:installResult) { $script:installResult.installed = $false; $script:installResult.rolled_back = $true }
    } elseif ($script:recoveryPath) {
        if ($script:installResult) { $script:installResult.rollback_status = 'recovery_required' }
    }
    $payload = @{ event = 'error'; status = if ($script:retainInstall) { 'installed_with_errors' } else { 'error' }; installed = $script:retainInstall; connected = $script:connected; identity_verified = $script:identityVerified; needs_user_action = $true; service_issuer = $ServiceIssuer; installation = $script:installResult; skill_path = $script:skillPath; code = if ($script:recoveryPath) { 'install_failed_recovery_required' } elseif ($script:retainInstall) { 'post_install_failed' } else { 'install_failed' }; message = $mainError; business_cli_available = $script:businessCliAvailable; tool_capability = 'not_checked' }
    if ($script:retainInstall -and $installedExe) { $payload.cli_path = $installedExe }
    $payload.phase = $script:installationPhase
    $payload.error_code = $failureCode
    $payload.exit_code = $script:failureExitCode
    $payload.next_action = 'Stop and provide this attempt ID and safe diagnostic export to the service owner. Do not guess paths, manually stage files, modify other products or repeat installation.'
    if ($script:authenticationErrorCode) { $payload.authentication_error_code = $script:authenticationErrorCode }
    if ($script:recoveryPath) {
        $payload.recovery_path = $script:recoveryPath
        $payload.recovery_error = $script:recoveryError
    }
    Emit-Result $payload
    exit $script:failureExitCode
} finally {
    if ($script:tempDir -and (Test-Path -LiteralPath $script:tempDir)) {
        Remove-Item -LiteralPath $script:tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
