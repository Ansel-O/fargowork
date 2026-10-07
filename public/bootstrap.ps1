#requires -Version 5.1
[CmdletBinding()]
param(
    [string[]]$Target = @('manual'),
    [string]$ServiceIssuer = 'https://fargowork.fargowealthapp.com',
    [switch]$Login,
    [ValidateSet('auto', 'always', 'never')]
    [string]$OpenBrowser = 'auto',
    [switch]$DryRun,
    [switch]$OutputJsonl
)

$ErrorActionPreference = 'Stop'
# Pin the built-in module to this runtime when launched by another AI shell.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Force
$version = '1.1.0'
$tag = 'v' + $version
$bundleName = "fargowork-employee-v$version-windows-x64.zip"
$repository = 'Ansel-O/fargowork'
$temporary = $null
$ownerToken = [guid]::NewGuid().ToString('N')
$exitCode = 4

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

try {
    $nativeArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
        -not [Environment]::Is64BitOperatingSystem -or $nativeArchitecture -ne 'AMD64') {
        throw 'This trial requires Windows x64. macOS is deferred.'
    }
    foreach ($name in ($Target -join ',').Split(',')) {
        if ($name.Trim().ToLowerInvariant() -notin @('manual', 'codex', 'cursor', 'workbuddy', 'claude-code')) {
            throw "Unsupported installation target: $name"
        }
    }
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
        throw 'The pinned release metadata does not match this bootstrap.'
    }
    $archivePath = Join-Path $temporary $bundleName
    Download-ReleaseFile "https://github.com/$repository/releases/download/$tag/$bundleName" $archivePath
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $metadata.archive.sha256 -or (Get-Item -LiteralPath $archivePath).Length -ne $metadata.archive.size) {
        throw 'The downloaded employee bundle failed SHA-256 or size verification.'
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $expected = @('README.md', 'DATA-AND-SUPPORT.md', 'install.ps1', 'release-manifest.json', 'SHA256SUMS', 'candidate-manifest.json',
            "fargowork-cli-v$version-windows-x64.zip", "fargowork-bridge-v$version-windows-x64.zip", "fargowork-agent-plugin-v$version-windows-x64.zip")
        $seen = @{}
        foreach ($entry in $archive.Entries) {
            if ($entry.FullName -cnotin $expected -or $seen.ContainsKey($entry.FullName) -or
                (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
                throw 'The employee bundle contains an unexpected, duplicate, or linked entry.'
            }
            $seen[$entry.FullName] = $true
        }
        if ($seen.Count -ne $expected.Count) { throw 'The employee bundle is incomplete.' }
    } finally { $archive.Dispose() }
    $extractRoot = Join-Path $temporary 'employee'
    [IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $extractRoot)
    $installer = Join-Path $extractRoot 'install.ps1'
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer,
        '-Version', $version, '-Target', ($Target -join ','), '-ServiceIssuer', $ServiceIssuer,
        '-LocalArtifactDir', $extractRoot)
    if ($Login) { $arguments += @('-Login', '-OpenBrowser', $OpenBrowser) }
    if ($DryRun) { $arguments += '-DryRun' }
    if ($OutputJsonl) { $arguments += '-OutputJsonl' }
    & powershell.exe @arguments
    $exitCode = $LASTEXITCODE
} catch {
    if ($OutputJsonl) {
        @{ event = 'bootstrap_error'; installed = $false; connected = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
    } else { Write-Error -ErrorAction Continue $_.Exception.Message }
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
        } catch { Write-Warning 'Bootstrap staging was retained because cleanup could not be verified.' }
    }
}
exit $exitCode
