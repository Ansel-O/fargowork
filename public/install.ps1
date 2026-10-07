[CmdletBinding()]
param(
    [string[]]$Target = @('manual'),
    [string]$Version = '1.1.0',
    [string]$ServiceIssuer,
    [string]$LocalArtifactDir,
    [string]$ReleaseBaseUrl,
    [switch]$Login,
    [ValidateSet('auto', 'always', 'never')]
    [string]$OpenBrowser = 'auto',
    [switch]$DryRun,
    [switch]$OutputJsonl
)

$ErrorActionPreference = 'Stop'
# Use this PowerShell runtime's built-in module even when an AI shell passed
# a PSModulePath containing modules from a different PowerShell version.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Force

function Emit-Result([hashtable]$Payload) {
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
    & $Exe @Arguments 2>&1 | ForEach-Object {
        try {
            $event = [string]$_ | ConvertFrom-Json -ErrorAction Stop
            if ($event.event -eq 'login_authorization_url') {
                if ($OutputJsonl) { Write-Host ($event | ConvertTo-Json -Compress -Depth 10) }
                else { Write-Host ("Open this login URL: {0}" -f $event.url) }
            } else { $capture.payload = $event }
        } catch {
            # Unexpected native diagnostics are not copied into structured logs.
        }
    }
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Payload = $capture.payload }
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
    if ($actual -ne $Expected) { throw "SHA256 mismatch for $($Path.Name)" }
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

try {
    $selectedTargets = @(Resolve-Targets $Target)
    if ($PSBoundParameters.ContainsKey('OpenBrowser') -and -not $Login) { throw '-OpenBrowser requires -Login.' }
    if (-not $ServiceIssuer) { throw 'Pass -ServiceIssuer with the real HTTPS FargoWork service address supplied by your administrator.' }
    if (-not $LocalArtifactDir -and -not $ReleaseBaseUrl) { throw 'Pass -LocalArtifactDir for a verified local candidate or -ReleaseBaseUrl for an explicitly published release.' }
    if ($ServiceIssuer -notmatch '^https://[^/]+/?$') { throw 'ServiceIssuer must be the HTTPS FargoWork issuer origin supplied by your administrator.' }
    $platformName = 'windows'
    $archName = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { throw '32-bit Windows is not supported by this release.' }

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
    Assert-Checksum $cliZip $checksums[$cliName]
    Assert-Checksum $bridgeZip $checksums[$bridgeName]
    Assert-Checksum $pluginZip $checksums[$pluginName]
    if ($DryRun) {
        Emit-Result @{ event = 'dry_run'; status = 'verified'; installed = $false; connected = $null; identity_verified = $false; trusted = 'unknown'; needs_user_action = $true; selected_targets = $selectedTargets; login_requested = [bool]$Login; message = 'local/remote artifacts verified; no files changed' }
        exit 0
    }

    $extractRoot = Join-Path $script:tempDir 'extract'
    $cliRoot = Join-Path $extractRoot 'cli'
    $pluginRoot = Join-Path $extractRoot 'plugin'
    New-Item -ItemType Directory -Path $cliRoot, $pluginRoot | Out-Null
    Expand-SafeZip $cliZip $cliRoot
    Expand-SafeZip $pluginZip $pluginRoot
    $exe = Get-ChildItem -LiteralPath $cliRoot -Filter 'fargowork.exe' -File -Recurse | Select-Object -First 1
    $pluginSource = Join-Path $pluginRoot 'fargowork'
    if (-not $exe -or -not (Test-Path -LiteralPath (Join-Path $pluginSource 'plugin.json') -PathType Leaf)) { throw 'Verified artifact is missing the FargoWork executable or plugin manifest.' }
    $pluginManifest = Get-Content -LiteralPath (Join-Path $pluginSource 'plugin.json') -Raw | ConvertFrom-Json
    if ($pluginManifest.name -ne 'fargowork-employee' -or $pluginManifest.version -ne $Version) { throw 'Verified plugin identity or version does not match this employee candidate.' }

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
    $successfulTargets = 0
    foreach ($selectedTarget in $selectedTargets) {
        $result = @{ target = $selectedTarget; status = 'error'; installed = $false; connected = $null; identity_verified = $false; trusted = 'unknown'; needs_user_action = $true }
        $script:targetResults.Add($result)
        try {
            $installation = Invoke-EmployeeCli $installedExe @('install', '--target', $selectedTarget, '--issuer', $ServiceIssuer, '--output', 'jsonl')
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
                $result.clients = $installation.Payload.clients
                if ($installation.ExitCode -ne 0) {
                    $result.requires_manual_recovery = $true
                    $result.mutation_may_have_happened = $hasMutationEvidence
                    $result.registration_evidence = $hasRegistrationEvidence
                }
            }
            if ($installation.ExitCode -ne 0 -or -not $installation.Payload.installed -or $installation.Payload.event -ne 'installed') {
                if ($installation.Payload.code) { $result.code = $installation.Payload.code }
                throw "FargoWork post-install for $selectedTarget failed (exit $($installation.ExitCode))."
            }
            $result.installed = $true
            # Registration may already reference this executable. A later
            # diagnostic or authentication failure must not remove it.
            $script:retainInstall = $true
            $diagnostic = Invoke-EmployeeCli $installedExe @('doctor', '--target', $selectedTarget, '--output', 'jsonl')
            $result.doctor_exit_code = $diagnostic.ExitCode
            if ($diagnostic.ExitCode -notin @(0, 3) -or $diagnostic.Payload.event -ne 'doctor' -or -not $diagnostic.Payload.installed) {
                if ($diagnostic.Payload.code) { $result.code = $diagnostic.Payload.code }
                throw "FargoWork doctor for $selectedTarget failed (exit $($diagnostic.ExitCode))."
            }
            $result.status = if ($diagnostic.ExitCode -eq 3) { 'needs_user_action' } else { 'installed' }
            $result.trusted = $diagnostic.Payload.trusted
            $result.clients = $diagnostic.Payload.clients
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
        $authentication = Invoke-EmployeeCli $installedExe @('login', '--browser', $OpenBrowser, '--output', 'jsonl')
        $script:connected = $false
        if ($authentication.ExitCode -ne 0 -or $authentication.Payload.event -ne 'logged_in' -or $authentication.Payload.connected -ne $true) {
            throw "FargoWork login failed (exit $($authentication.ExitCode)); installed files and personal state were retained."
        }
        $verifiedTargets = 0
        foreach ($result in $script:targetResults) {
            $verification = Invoke-EmployeeCli $installedExe @('status', '--target', $result.target, '--output', 'jsonl')
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
            $result.clients = $verification.Payload.clients
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
    if ($cleanupPending) { $payload.recovery_path = $script:recoveryPath; $payload.message = $script:recoveryError }
    Emit-Result $payload
    exit 0
} catch {
    $mainError = $_.Exception.Message
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
