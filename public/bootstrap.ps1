#requires -Version 5.1
[CmdletBinding()]
param(
    [string[]]$Target = @('cli'),
    [string]$ServiceIssuer = 'https://fargowork.fargowealthapp.com',
    [switch]$Login,
    [ValidateSet('auto', 'always', 'never')]
    [string]$OpenBrowser = 'auto',
    [switch]$DryRun,
    [switch]$OutputJsonl,
    [string]$CodexPath,
    [string]$AttemptId
)

$ErrorActionPreference = 'Stop'
# Pin the built-in module to this runtime when launched by another AI shell.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Force
$version = '1.3.0'
$tag = 'v' + $version
$bundleName = "fargowork-employee-v$version-windows-x64.zip"
$repository = 'Ansel-O/fargowork'
$temporary = $null
$ownerToken = [guid]::NewGuid().ToString('N')
$exitCode = 4
$script:diagnosticComponent = 'bootstrap'
$script:diagnosticUnavailable = $false
$script:attemptId = $null
$script:diagnosticDirectory = $null
$script:resolvedCodexPath = $null
$script:installationPhase = 'preflight'
$script:bootstrapPayload = $null


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

function Assert-NoReparseChain([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing a linked bootstrap path.' }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Download-ReleaseFile([string]$Uri, [string]$Destination) {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try { Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination; return }
        catch { if ($attempt -eq 3) { throw }; Start-Sleep -Seconds $attempt }
    }
}

function Invoke-InstallerLauncher([string[]]$Arguments) {
    # Keep one final result and only the functional browser=never authorization
    # link. Native stderr and diagnostic progress never become installer output.
    $script:launcherStructuredResult = $false
    $capture = @{ payload = $null }
    $previousErrorPreference = $ErrorActionPreference
    if ($Login -and $OpenBrowser -ne 'never') { Write-Host 'Complete DingTalk authorization in the opened browser.' }
    try {
        $ErrorActionPreference = 'Continue'
        & powershell.exe @Arguments 2>&1 | ForEach-Object {
        try {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { return }
            $event = [string]$_ | ConvertFrom-Json -ErrorAction Stop
            if ($event.event -in @('installed', 'error', 'dry_run')) {
                $script:launcherStructuredResult = $true
                $capture.payload = $event
            } elseif ($event.event -eq 'login_authorization_url' -and $OpenBrowser -eq 'never') {
                Write-Host (@{ event = 'login_authorization_url'; url = [string]$event.url; attempt_id = $script:attemptId } | ConvertTo-Json -Compress -Depth 3)
            }
        } catch { }
        }
    } finally { $ErrorActionPreference = $previousErrorPreference }
    $nativeExit = $LASTEXITCODE
    if ($capture.payload) { $script:bootstrapPayload = $capture.payload }
    return $nativeExit
}

try {
    Resolve-InstallationAttempt
    $nativeArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
        -not [Environment]::Is64BitOperatingSystem -or $nativeArchitecture -ne 'AMD64') {
        throw 'This trial requires Windows x64. macOS is deferred.'
    }
    $selectedTargets = @()
    foreach ($name in ($Target -join ',').Split(',')) {
        if ($name.Trim().ToLowerInvariant() -notin @('cli', 'manual', 'codex', 'cursor', 'workbuddy', 'claude-code')) {
            throw "Unsupported installation target: $name"
        }
        $selectedTargets += $name.Trim().ToLowerInvariant()
    }
    Invoke-HostPreflight $selectedTargets
    Write-InstallationDiagnostic 'installation_started' 'start' 'started'
    Write-InstallationDiagnostic 'preflight_result' 'preflight' 'succeeded'
    $script:installationPhase = 'download'
    $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    Assert-NoReparseChain $tempBase
    $temporary = Join-Path $tempBase ("fargowork-bootstrap-" + $ownerToken)
    if (Test-Path -LiteralPath $temporary) { throw 'Bootstrap staging already exists.' }
    New-Item -ItemType Directory -Path $temporary | Out-Null
    [IO.File]::WriteAllText((Join-Path $temporary '.bootstrap-owner'), $ownerToken)
    $metadataPath = Join-Path $temporary 'windows-trial.json'
    Download-ReleaseFile "https://raw.githubusercontent.com/$repository/$tag/public/release/windows-trial.json" $metadataPath
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    if ($metadata.version -ne $version -or $metadata.tag -ne $tag -or $metadata.repository -ne $repository -or
        $metadata.archive.name -ne $bundleName -or $metadata.archive.sha256 -notmatch '^[0-9a-f]{64}$') {
        throw '[artifact_invalid] The pinned release metadata does not match this bootstrap.'
    }
    $archivePath = Join-Path $temporary $bundleName
    Download-ReleaseFile "https://github.com/$repository/releases/download/$tag/$bundleName" $archivePath
    $script:installationPhase = 'verify'
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $metadata.archive.sha256 -or (Get-Item -LiteralPath $archivePath).Length -ne $metadata.archive.size) {
        throw '[artifact_invalid] The downloaded employee bundle failed SHA-256 or size verification.'
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $expected = @('README.md', 'DATA-AND-SUPPORT.md', 'DEBUG.md', 'install.ps1', 'release-manifest.json', 'SHA256SUMS', 'candidate-manifest.json',
            "fargowork-cli-v$version-windows-x64.zip", "fargowork-bridge-v$version-windows-x64.zip", "fargowork-agent-plugin-v$version-windows-x64.zip")
        $seen = @{}
        foreach ($entry in $archive.Entries) {
            if ($entry.FullName -cnotin $expected -or $seen.ContainsKey($entry.FullName) -or
                (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
                throw '[artifact_invalid] The employee bundle contains an unexpected, duplicate, or linked entry.'
            }
            $seen[$entry.FullName] = $true
        }
        if ($seen.Count -ne $expected.Count) { throw '[artifact_invalid] The employee bundle is incomplete.' }
    } finally { $archive.Dispose() }
    Write-InstallationDiagnostic 'package_verified' 'verify' 'succeeded'
    $extractRoot = Join-Path $temporary 'employee'
    [IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $extractRoot)
    $installer = Join-Path $extractRoot 'install.ps1'
    $arguments = @('-NoProfile', '-File', $installer,
        '-Version', $version, '-Target', ($Target -join ','), '-ServiceIssuer', $ServiceIssuer,
        '-LocalArtifactDir', $extractRoot, '-AttemptId', $script:attemptId, '-OutputJsonl')
    if ($script:resolvedCodexPath) { $arguments += @('-CodexPath', $script:resolvedCodexPath) }
    if ($Login) { $arguments += @('-Login', '-OpenBrowser', $OpenBrowser) }
    if ($DryRun) { $arguments += '-DryRun' }
    $script:installationPhase = 'stage'
    Write-InstallationDiagnostic 'launcher_started' 'start' 'started'
    $exitCode = Invoke-InstallerLauncher $arguments
    Write-InstallationDiagnostic 'launcher_finished' 'finish' $(if ($exitCode -eq 0) { 'succeeded' } else { 'failed' }) '' $exitCode
    if (-not $script:launcherStructuredResult) {
        if ($exitCode -eq 0) { $exitCode = 4 }
        $script:bootstrapPayload = @{ event = 'bootstrap_error'; installed = $false; connected = $false; attempt_id = $script:attemptId;
           diagnostic_log_dir = $script:diagnosticDirectory; error_code = 'launcher_failed'; exit_code = $exitCode;
           message = 'The official installer did not return a structured result. Its script may have been blocked or could not start; no alternate execution method was attempted.';
           next_action = 'Stop and report this attempt to the service owner. Follow company policy; do not repeat installation or bypass the restriction.' }
    }
} catch {
    $failureCode = Get-InstallationErrorCode $_.Exception.Message
    Write-InstallationDiagnostic 'installation_finished' $script:installationPhase 'failed' $failureCode 4
    $script:bootstrapPayload = @{ event = 'bootstrap_error'; installed = $false; connected = $false; message = $_.Exception.Message; error_code = $failureCode;
           phase = $script:installationPhase; attempt_id = $script:attemptId; diagnostic_log_dir = $script:diagnosticDirectory;
           diagnostic_available = -not $script:diagnosticUnavailable;
           next_action = 'Stop and provide the attempt ID and safe diagnostic export to the service owner. Do not guess paths, bypass company policy, manually stage files or repeat installation.' }
    $exitCode = 4
} finally {
    if ($temporary -and (Test-Path -LiteralPath $temporary)) {
        # Only remove this invocation's absolute, unlinked, ownership-marked staging.
        try {
            $resolved = [IO.Path]::GetFullPath($temporary)
            if ([IO.Path]::GetDirectoryName($resolved).TrimEnd('\') -cne $tempBase.TrimEnd('\') -or
                [IO.Path]::GetFileName($resolved) -cne ("fargowork-bootstrap-" + $ownerToken)) {
                throw 'Bootstrap cleanup path escaped its staging root.'
            }
            Assert-NoReparseChain $resolved
            $marker = Join-Path $resolved '.bootstrap-owner'
            Assert-NoReparseChain $marker
            foreach ($item in @(Get-ChildItem -LiteralPath $resolved -Force -Recurse -ErrorAction Stop)) {
                if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw 'Bootstrap cleanup found a linked staging entry.'
                }
            }
            if ([IO.File]::ReadAllText($marker) -cne $ownerToken) {
                throw 'Bootstrap cleanup ownership could not be verified.'
            }
            Remove-Item -LiteralPath $resolved -Recurse -Force
        } catch {
            # Keep recovery explicit in the single final result. A warning after
            # that result would obscure the machine-readable completion contract.
            if ($script:bootstrapPayload) {
                if ($script:bootstrapPayload -is [System.Collections.IDictionary]) {
                    $script:bootstrapPayload.recovery_staging_retained = $true
                    $script:bootstrapPayload.recovery_path = $temporary
                } else {
                    $script:bootstrapPayload | Add-Member -NotePropertyName 'recovery_staging_retained' -NotePropertyValue $true -Force
                    $script:bootstrapPayload | Add-Member -NotePropertyName 'recovery_path' -NotePropertyValue $temporary -Force
                }
            }
        }
    }
}
if ($script:bootstrapPayload) { $script:bootstrapPayload | ConvertTo-Json -Compress -Depth 10 }
exit $exitCode
