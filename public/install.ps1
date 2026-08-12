[CmdletBinding()]
param(
    [ValidateSet('all', 'workbuddy', 'codex', 'cursor')]
    [string]$Target = 'all',
    [string]$Version = '0.5.0-rc.5',
    [string]$LocalArtifactDir,
    [string]$ReleaseBaseUrl,
    [switch]$DryRun,
    [switch]$OutputJsonl
)

$ErrorActionPreference = 'Stop'

if (-not $ReleaseBaseUrl) {
    $ReleaseBaseUrl = "https://github.com/Ansel-O/fargowork/releases/download/v$Version"
}

function Emit-Result([hashtable]$Payload) {
    if ($OutputJsonl) {
        $Payload | ConvertTo-Json -Compress -Depth 10
    } else {
        $detail = if ($Payload.message) { $Payload.message } elseif ($Payload.status) { $Payload.status } else { '' }
        Write-Output ("{0}: {1}" -f $Payload.event, $detail)
    }
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
            if ([string]::IsNullOrWhiteSpace($name) -or [System.IO.Path]::IsPathRooted($name) -or $name.Split('/') -contains '..' -or $name.Contains([char]0)) { throw "Unsafe ZIP path: $name" }
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

try {
    $platformName = 'windows'
    $archName = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { throw '32-bit Windows is not supported by this release.' }
    $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("fargowork-install-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tempDir | Out-Null
    try {
        $checksumPath = Download-OrUseLocal 'SHA256SUMS' $LocalArtifactDir $ReleaseBaseUrl $tempDir
        $checksums = Read-Checksums $checksumPath
        $cliName = "fargowork-cli-v$Version-$platformName-$archName.zip"
        $bridgeName = "fargowork-bridge-v$Version-$platformName-$archName.zip"
        $pluginName = "fargowork-agent-plugin-v$Version-$platformName-$archName.zip"
        foreach ($name in @($cliName, $bridgeName, $pluginName)) {
            if (-not $checksums.ContainsKey($name)) { throw "SHA256SUMS does not declare $name" }
        }
        $cliZip = Download-OrUseLocal $cliName $LocalArtifactDir $ReleaseBaseUrl $tempDir
        $bridgeZip = Download-OrUseLocal $bridgeName $LocalArtifactDir $ReleaseBaseUrl $tempDir
        $pluginZip = Download-OrUseLocal $pluginName $LocalArtifactDir $ReleaseBaseUrl $tempDir
        Assert-Checksum $cliZip $checksums[$cliName]
        Assert-Checksum $bridgeZip $checksums[$bridgeName]
        Assert-Checksum $pluginZip $checksums[$pluginName]
        if ($DryRun) {
            Emit-Result @{ event = 'dry_run'; status = 'verified'; installed = $false; connected = $false; trusted = 'unknown'; needs_user_action = $true; message = 'local/remote artifacts verified; no files changed' }
            exit 0
        }

        $extractRoot = Join-Path $tempDir 'extract'
        $cliRoot = Join-Path $extractRoot 'cli'
        $pluginRoot = Join-Path $extractRoot 'plugin'
        New-Item -ItemType Directory -Path $cliRoot, $pluginRoot | Out-Null
        Expand-SafeZip $cliZip $cliRoot
        Expand-SafeZip $pluginZip $pluginRoot
        $exe = Get-ChildItem -LiteralPath $cliRoot -Filter 'fargowork.exe' -File -Recurse | Select-Object -First 1
        $pluginSource = Join-Path $pluginRoot 'fargowork'
        if (-not $exe -or -not (Test-Path -LiteralPath (Join-Path $pluginSource 'plugin.json'))) { throw 'Verified artifact is missing the FargoWork executable or plugin manifest.' }

        # The CLI's Windows user-level config/plugin home is APPDATA.  Keep
        # the executable and plugin under the same owned root so a post-install
        # doctor observes exactly what the installer placed.
        $appData = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $env:USERPROFILE 'AppData\Roaming' }
        $installRoot = Join-Path $appData 'FargoWork'
        $binDir = Join-Path $installRoot 'bin'
        $pluginDest = Join-Path $installRoot 'plugin\fargowork'
        $stage = Join-Path $tempDir 'stage'
        New-Item -ItemType Directory -Path (Join-Path $stage 'bin'), (Join-Path $stage 'plugin') | Out-Null
        Copy-Item -LiteralPath $exe.FullName -Destination (Join-Path $stage 'bin\fargowork.exe')
        Copy-Item -LiteralPath $pluginSource -Destination (Join-Path $stage 'plugin\fargowork') -Recurse
        New-Item -ItemType Directory -Path (Join-Path $stage 'plugin\fargowork\bin') -Force | Out-Null
        Copy-Item -LiteralPath $exe.FullName -Destination (Join-Path $stage 'plugin\fargowork\bin\fargowork.exe') -Force
        Set-Content -LiteralPath (Join-Path $stage 'plugin\fargowork\.fargowork-owner') -Value 'fargowork-owned-v1' -Encoding UTF8

        New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
        $backup = Join-Path $tempDir 'backup'
        New-Item -ItemType Directory -Path $backup | Out-Null
        if (Test-Path -LiteralPath $pluginDest) {
            $owner = Join-Path $pluginDest '.fargowork-owner'
            if (-not (Test-Path -LiteralPath $owner) -or ((Get-Content -LiteralPath $owner -Raw).Trim() -ne 'fargowork-owned-v1')) { throw 'Refusing to overwrite a non-FargoWork plugin directory.' }
        }
        $backupBin = Join-Path $backup 'bin'
        $backupPlugin = Join-Path $backup 'plugin'
        $rollback = {
            if (Test-Path -LiteralPath $binDir) { Remove-Item -LiteralPath $binDir -Recurse -Force -ErrorAction SilentlyContinue }
            if (Test-Path -LiteralPath $pluginDest) { Remove-Item -LiteralPath $pluginDest -Recurse -Force -ErrorAction SilentlyContinue }
            if (Test-Path -LiteralPath $backupBin) { Move-Item -LiteralPath $backupBin -Destination $binDir -Force }
            if (Test-Path -LiteralPath $backupPlugin) {
                New-Item -ItemType Directory -Path (Split-Path -Parent $pluginDest) -Force | Out-Null
                Move-Item -LiteralPath $backupPlugin -Destination $pluginDest -Force
            }
        }
        try {
            if (Test-Path -LiteralPath $binDir) { Move-Item -LiteralPath $binDir -Destination $backupBin }
            if (Test-Path -LiteralPath $pluginDest) { Move-Item -LiteralPath $pluginDest -Destination $backupPlugin }
            Move-Item -LiteralPath (Join-Path $stage 'bin') -Destination $binDir
            New-Item -ItemType Directory -Path (Split-Path -Parent $pluginDest) -Force | Out-Null
            Move-Item -LiteralPath (Join-Path $stage 'plugin\fargowork') -Destination $pluginDest
            $installedExe = Join-Path $binDir 'fargowork.exe'
            & $installedExe install --target $Target --output jsonl
            $installExit = $LASTEXITCODE
            if ($installExit -ne 0) { throw "FargoWork post-install returned exit code $installExit" }
            & $installedExe doctor --target $Target --output jsonl
            $doctorExit = $LASTEXITCODE
            if ($doctorExit -ne 0 -and $doctorExit -ne 3) { throw "FargoWork doctor returned exit code $doctorExit" }
        } catch {
            & $rollback
            throw
        }
        $ready = $doctorExit -eq 0
        $message = if ($Target -eq 'workbuddy' -or $Target -eq 'all') {
            'FargoWork installed. Complete login and WorkBuddy UI trust/enable if using WorkBuddy.'
        } else {
            "FargoWork installed for $Target."
        }
        Emit-Result @{ event = 'installed'; status = if ($ready) { 'ready' } else { 'needs_user_action' }; installed = $true; connected = $ready; trusted = if ($ready) { $true } else { 'unknown' }; needs_user_action = -not $ready; plugin_dir = $pluginDest; message = $message }
        exit 0
    } finally {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
} catch {
    Emit-Result @{ event = 'error'; status = 'error'; installed = $false; connected = $false; trusted = 'unknown'; needs_user_action = $true; code = 'install_failed'; message = $_.Exception.Message }
    exit 4
}
