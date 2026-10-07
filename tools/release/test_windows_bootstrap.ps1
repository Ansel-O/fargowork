[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$bootstrap = Join-Path $repositoryRoot 'public\bootstrap.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('fargowork-bootstrap-fixture-' + [guid]::NewGuid().ToString('N'))
$environmentNames = @('APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'TEMP', 'TMP', 'FARGOWORK_BOOTSTRAP_FIXTURE_RECORD', 'FARGOWORK_BOOTSTRAP_FIXTURE_EXIT', 'FARGOWORK_BOOTSTRAP_FIXTURE_MODE')
$savedEnvironment = @{}
foreach ($name in $environmentNames) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$oldWebRequest = Get-Item Function:\global:Invoke-WebRequest -ErrorAction SilentlyContinue
$oldFixture = $global:WindowsBootstrapFixture
$oldExit = $global:BootstrapFixtureExitCode

function Assert-Fixture([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function global:Invoke-WebRequest {
    [CmdletBinding()]
    param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
    $fixture = $global:WindowsBootstrapFixture
    $fixture.downloads.Add($OutFile)
    if ($Uri -ceq 'https://raw.githubusercontent.com/Ansel-O/fargowork/v1.3.0/public/release/windows-trial.json') {
        Copy-Item -LiteralPath $fixture.metadata -Destination $OutFile
        if ($fixture.mode -eq 'owner-mismatch') {
            [IO.File]::WriteAllText((Join-Path (Split-Path -Parent $OutFile) '.bootstrap-owner'), 'foreign-owner')
        }
    } elseif ($Uri -ceq 'https://github.com/Ansel-O/fargowork/releases/download/v1.3.0/fargowork-employee-v1.3.0-windows-x64.zip') {
        Copy-Item -LiteralPath $fixture.archive -Destination $OutFile
    } else { throw "Unexpected fixture network request: $Uri" }
}

function New-BootstrapFixture([string]$Name, [string]$Mode = 'success', [int]$ChildExit = 0) {
    $caseRoot = Join-Path $testRoot $Name
    $tempRoot = Join-Path $caseRoot 'Temp'
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    $archivePath = Join-Path $caseRoot 'fargowork-employee-v1.3.0-windows-x64.zip'
    $stubInstaller = @'
[CmdletBinding()]
param([string[]]$Target, [string]$Version, [string]$ServiceIssuer,
      [string]$LocalArtifactDir, [switch]$Login, [string]$OpenBrowser = 'auto',
      [switch]$DryRun, [switch]$OutputJsonl, [string]$CodexPath, [string]$AttemptId)
$record = @{ targets = ($Target -join ',').Split(','); version = $Version;
    issuer = $ServiceIssuer; login = [bool]$Login; browser = $OpenBrowser;
    explicit_browser = $PSBoundParameters.ContainsKey('OpenBrowser');
    artifact_dir = $LocalArtifactDir; dry_run = [bool]$DryRun; jsonl = [bool]$OutputJsonl;
    appdata = $env:APPDATA; userprofile = $env:USERPROFILE; attempt_id = $AttemptId; codex_path = $CodexPath }
[IO.File]::WriteAllText($env:FARGOWORK_BOOTSTRAP_FIXTURE_RECORD, ($record | ConvertTo-Json -Compress))
if ($env:FARGOWORK_BOOTSTRAP_FIXTURE_MODE -eq 'silent-child') {
    [Console]::Error.WriteLine('secret-fixture-launcher-stderr-must-not-appear')
    exit 29
}
$employeeRoot = Join-Path $env:APPDATA 'FargoWork\employee'
New-Item -ItemType Directory -Path $employeeRoot -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $employeeRoot 'installed.fixture'), 'installed-outside-bootstrap-staging')
$childExit = [int]$env:FARGOWORK_BOOTSTRAP_FIXTURE_EXIT
Write-Output '{"event":"login_started","phase":"login","outcome":"started","private":"secret-fixture-stage-must-not-appear"}'
[Console]::Error.WriteLine('secret-fixture-launcher-stderr-must-not-appear')
if ($Login -and $OpenBrowser -eq 'never') { Write-Output '{"event":"login_authorization_url","url":"https://employee-fixture.invalid/oauth/authorize?state=private-fixture-state&code_challenge=private-fixture-challenge","private":"secret-fixture-extra-must-not-appear"}' }
elseif ($Login) { Write-Output '{"event":"login_browser_opened","private":"secret-fixture-extra-must-not-appear"}' }
@{ event = 'installed'; installed = $true; connection_mode = 'cli'; mcp_registration_required = $false; business_cli_available = $true; tool_capability = 'not_checked'; trusted = 'not_required'; connected = if ($childExit -eq 0 -and $Login) { $true } elseif ($Login) { $false } else { $null } } | ConvertTo-Json -Compress
exit $childExit
'@
    $entries = [ordered]@{
        'README.md' = 'fixture readme'
        'DATA-AND-SUPPORT.md' = 'fixture support'
        'DEBUG.md' = 'fixture debug'
        'install.ps1' = $stubInstaller
        'release-manifest.json' = '{}'
        'SHA256SUMS' = 'fixture checksums'
        'candidate-manifest.json' = '{}'
        'fargowork-cli-v1.3.0-windows-x64.zip' = 'fixture cli'
        'fargowork-bridge-v1.3.0-windows-x64.zip' = 'fixture bridge'
        'fargowork-agent-plugin-v1.3.0-windows-x64.zip' = 'fixture plugin'
    }
    if ($Mode -eq 'extra-entry') { $entries['unexpected.txt'] = 'must reject before executing installer' }
    if ($Mode -eq 'missing-debug') { $entries.Remove('DEBUG.md') }
    $archive = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in $entries.Keys) {
            $entry = $archive.CreateEntry($name)
            $stream = $entry.Open()
            try {
                $bytes = [Text.UTF8Encoding]::new($true).GetBytes($entries[$name])
                $stream.Write($bytes, 0, $bytes.Length)
            } finally { $stream.Dispose() }
        }
    } finally { $archive.Dispose() }
    $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $size = (Get-Item -LiteralPath $archivePath).Length
    if ($Mode -eq 'bad-hash') { $hash = '0' * 64 }
    if ($Mode -eq 'bad-size') { $size++ }
    $metadataPath = Join-Path $caseRoot 'windows-trial.json'
    @{ version = '1.3.0'; tag = 'v1.3.0'; repository = 'Ansel-O/fargowork'; archive = @{ name = 'fargowork-employee-v1.3.0-windows-x64.zip'; sha256 = $hash; size = $size } } |
        ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $metadataPath -Encoding UTF8
    return @{ root = $caseRoot; temporary_root = $tempRoot; metadata = $metadataPath; archive = $archivePath; mode = $Mode; child_exit = $ChildExit;
        record = (Join-Path $caseRoot 'child-arguments.json'); downloads = [System.Collections.Generic.List[string]]::new() }
}

function Invoke-BootstrapFixture([hashtable]$Fixture, [string[]]$Targets = @(), [switch]$WithLogin, [switch]$Human, [string]$Browser = 'always') {
    $global:WindowsBootstrapFixture = $Fixture
    $global:BootstrapFixtureExitCode = -1
    $env:APPDATA = Join-Path $Fixture.root 'Profile\Roaming'
    $env:LOCALAPPDATA = Join-Path $Fixture.root 'Profile\Local'
    $env:USERPROFILE = Join-Path $Fixture.root 'Profile'
    $env:HOME = $env:USERPROFILE
    $env:CODEX_HOME = Join-Path $Fixture.root 'Profile\.codex'
    $env:CLAUDE_CONFIG_DIR = Join-Path $Fixture.root 'Profile\.claude'
    $env:TEMP = $Fixture.temporary_root
    $env:TMP = $Fixture.temporary_root
    $env:FARGOWORK_BOOTSTRAP_FIXTURE_RECORD = $Fixture.record
    $env:FARGOWORK_BOOTSTRAP_FIXTURE_EXIT = [string]$Fixture.child_exit
    $env:FARGOWORK_BOOTSTRAP_FIXTURE_MODE = [string]$Fixture.mode
    New-Item -ItemType Directory -Path $env:APPDATA, $env:LOCALAPPDATA, $env:CODEX_HOME, $env:CLAUDE_CONFIG_DIR -Force | Out-Null
    $parameters = @{ OutputJsonl = -not $Human }
    if ($Targets.Count -gt 0) { $parameters.Target = $Targets }
    if ($WithLogin) { $parameters.Login = $true; $parameters.OpenBrowser = $Browser }
    $output = @(& $script:fixtureBootstrap @parameters 2>&1 3>&1 6>&1)
    $record = if (Test-Path -LiteralPath $Fixture.record) { Get-Content -LiteralPath $Fixture.record -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
    $stages = @(Get-ChildItem -LiteralPath $Fixture.temporary_root -Directory -Filter 'fargowork-bootstrap-*')
    return @{ exit_code = [int]$global:BootstrapFixtureExitCode; output = $output; record = $record; stages = $stages }
}

try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $source = [IO.File]::ReadAllText($bootstrap, [Text.Encoding]::UTF8)
    $bootstrapAst = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$null, [ref]$null)
    $hostPreflight = @($bootstrapAst.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-HostPreflight' }, $true))
    if ($hostPreflight.Count -ne 1) { throw 'Could not isolate bootstrap host probing.' }
    $hostExtent = $hostPreflight[0].Extent
    $source = $source.Remove($hostExtent.StartOffset, $hostExtent.EndOffset - $hostExtent.StartOffset).Insert($hostExtent.StartOffset, 'function Invoke-HostPreflight([string[]]$Targets) { if ($global:WindowsBootstrapFixture.mode -eq ''missing-client'') { throw ''[client_not_detected] Codex was not found; supply -CodexPath.'' }; if (''codex'' -in $Targets) { $script:resolvedCodexPath = ''C:\fixture\embedded\codex.exe'' } }')
    if (-not $source.Contains('exit $exitCode')) { throw 'Cannot isolate the bootstrap exit statement.' }
    $script:fixtureBootstrap = Join-Path $testRoot 'bootstrap-fixture.ps1'
    [IO.File]::WriteAllText($script:fixtureBootstrap, $source.Replace('exit $exitCode', '$global:BootstrapFixtureExitCode = $exitCode; return'), [Text.UTF8Encoding]::new($true))

    $default = New-BootstrapFixture ('default cli ' + [char]0x6d4b + [char]0x8bd5)
    $defaultResult = Invoke-BootstrapFixture $default
    Assert-Fixture ($defaultResult.exit_code -eq 0 -and $defaultResult.record.targets[0] -eq 'cli') 'Default bootstrap did not execute the CLI child installer'
    Assert-Fixture (-not $defaultResult.record.login -and -not $defaultResult.record.explicit_browser) 'Default bootstrap passed login-only arguments without Login'
    Assert-Fixture ($defaultResult.record.version -eq '1.3.0' -and $defaultResult.record.jsonl) 'Pinned version or JSONL option did not reach the child installer'
    Assert-Fixture ($defaultResult.output.Count -eq 1 -and ([string]$defaultResult.output[0] | ConvertFrom-Json).tool_capability -eq 'not_checked') 'Default bootstrap did not preserve one final CLI capability result'
    Assert-Fixture (($defaultResult.output -join ' ') -notmatch 'secret-fixture|login_started') 'Bootstrap emitted diagnostics or raw native stderr'
    Assert-Fixture ($defaultResult.stages.Count -eq 0 -and $default.downloads.Count -eq 2) 'Successful bootstrap did not clean only its owned temporary download directory'
    Assert-Fixture (Test-Path -LiteralPath (Join-Path $defaultResult.record.appdata 'FargoWork\employee\installed.fixture')) 'Bootstrap cleanup removed employee installation state'

    $human = New-BootstrapFixture 'human output default'
    $humanResult = Invoke-BootstrapFixture $human -Human
    Assert-Fixture ($humanResult.exit_code -eq 0 -and $humanResult.record.jsonl) 'Human output disabled the structured child contract'
    Assert-Fixture ($humanResult.output.Count -eq 1 -and ([string]$humanResult.output[0] | ConvertFrom-Json).event -eq 'installed') 'Default output was not one machine-readable result'

    $multiple = New-BootstrapFixture 'multi target login'
    $multipleResult = Invoke-BootstrapFixture $multiple @('cursor,codex', 'claude-code') -WithLogin
    Assert-Fixture ($multipleResult.exit_code -eq 0 -and ($multipleResult.record.targets -join ',') -eq 'cursor,codex,claude-code') 'Comma/array multi-target parameters did not reach the child installer'
    Assert-Fixture ($multipleResult.record.login -and $multipleResult.record.explicit_browser -and $multipleResult.record.browser -eq 'always') 'Login/browser arguments did not reach the child installer'
    Assert-Fixture ($multipleResult.record.codex_path -eq 'C:\fixture\embedded\codex.exe' -and $multipleResult.record.attempt_id -match '^[0-9a-f-]{36}$') 'Verified Codex path or attempt key did not reach the child installer'
    Assert-Fixture ($multipleResult.stages.Count -eq 0) 'Multi-target bootstrap leaked owned temporary staging'
    Assert-Fixture (($multipleResult.output -join ' ') -notmatch 'private-fixture-state|code_challenge|login_authorization_url|login_started|secret-fixture') 'Default browser mode exposed authorization query or phase diagnostics'

    $manualBrowser = New-BootstrapFixture 'explicit manual browser'
    $manualBrowserResult = Invoke-BootstrapFixture $manualBrowser -WithLogin -Browser 'never'
    $manualEvents = @($manualBrowserResult.output | ForEach-Object { [string]$_ | ConvertFrom-Json })
    Assert-Fixture ($manualBrowserResult.exit_code -eq 0 -and $manualEvents.Count -eq 2 -and $manualEvents[0].event -eq 'login_authorization_url' -and $manualEvents[0].url -match '^https://employee-fixture.invalid/' -and $manualEvents[1].event -eq 'installed') 'Explicit browser=never lost its functional authorization link or single terminal result'
    Assert-Fixture (($manualBrowserResult.output -join ' ') -notmatch 'secret-fixture|login_started') 'Manual browser output exposed unrelated diagnostic fields'
    $manualDiagnosticFiles = @(Get-ChildItem -LiteralPath (Join-Path $manualBrowser.root 'Profile\Roaming\FargoWork\diagnostics') -Filter 'diagnostic-*.jsonl' -File)
    foreach ($diagnosticFile in $manualDiagnosticFiles) { Assert-Fixture ((Get-Content -LiteralPath $diagnosticFile.FullName -Raw) -notmatch 'authorize|private-fixture|code_challenge|url') 'Authorization URL entered the persistent diagnostic log' }

    $missingClient = New-BootstrapFixture 'missing embedded client' 'missing-client'
    $missingClientResult = Invoke-BootstrapFixture $missingClient @('codex')
    Assert-Fixture ($missingClientResult.exit_code -eq 4 -and $missingClient.downloads.Count -eq 0 -and $null -eq $missingClientResult.record) 'Missing client was detected only after download or child installation'
    Assert-Fixture (($missingClientResult.output -join ' ') -match 'CodexPath') 'Missing embedded client omitted the explicit path option'
    $failureDiagnostics = @(Get-ChildItem -LiteralPath (Join-Path $missingClient.root 'Profile\Roaming\FargoWork\diagnostics') -Filter 'diagnostic-*.jsonl' -File)
    Assert-Fixture ($failureDiagnostics.Count -eq 1) 'Early bootstrap failure did not leave a bounded safe diagnostic'

    foreach ($failure in @('bad-hash', 'bad-size', 'extra-entry', 'missing-debug')) {
        $fixture = New-BootstrapFixture $failure $failure
        $result = Invoke-BootstrapFixture $fixture
        Assert-Fixture ($result.exit_code -eq 4 -and $null -eq $result.record) "$failure`: unverified package executed the child installer"
        Assert-Fixture ($result.stages.Count -eq 0) "$failure`: failed bootstrap did not clean its safe owned staging"
    }

    $authFailure = New-BootstrapFixture 'child auth failure' 'success' 43
    $authFailureResult = Invoke-BootstrapFixture $authFailure @('manual') -WithLogin
    Assert-Fixture ($authFailureResult.exit_code -eq 43 -and $authFailureResult.record.login) 'Bootstrap did not propagate child authentication failure'
    Assert-Fixture ($authFailureResult.stages.Count -eq 0 -and (Test-Path -LiteralPath (Join-Path $authFailureResult.record.appdata 'FargoWork\employee\installed.fixture'))) 'Authentication failure cleanup removed installed employee state or leaked safe staging'

    $silentChild = New-BootstrapFixture 'blocked child' 'silent-child'
    $silentResult = Invoke-BootstrapFixture $silentChild
    Assert-Fixture ($silentResult.exit_code -eq 29 -and ($silentResult.output -join ' ') -match 'launcher_failed') 'Missing installer result lost its real exit or fixed launcher diagnosis'
    Assert-Fixture (($silentResult.output -join ' ') -notmatch 'secret-fixture-launcher-stderr-must-not-appear') 'Launcher exposed raw native stderr'

    $ownerMismatch = New-BootstrapFixture 'owner mismatch' 'owner-mismatch'
    $ownerResult = Invoke-BootstrapFixture $ownerMismatch
    Assert-Fixture ($ownerResult.exit_code -eq 0 -and $ownerResult.stages.Count -eq 1) 'Bootstrap removed staging whose exact ownership could not be verified'
    Assert-Fixture ((Get-Content -LiteralPath (Join-Path $ownerResult.stages[0].FullName '.bootstrap-owner') -Raw) -eq 'foreign-owner') 'Unverified staging ownership marker was changed during cleanup'
    Assert-Fixture (([string]$ownerResult.output[-1] | ConvertFrom-Json).recovery_staging_retained) 'Retained bootstrap staging was not recorded in the final result'
    Write-Output 'Windows bootstrap fixture: PASS (pinned 1.3.0 ten-entry ZIP; quiet default CLI; optional MCP targets; login query suppressed; bad hash/size/entry rejection; true child exit; recovery retained; employee state preserved)'
} finally {
    foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
    $global:WindowsBootstrapFixture = $oldFixture
    $global:BootstrapFixtureExitCode = $oldExit
    if ($oldWebRequest) { Set-Item Function:\global:Invoke-WebRequest -Value $oldWebRequest.ScriptBlock -Force }
    else { Remove-Item Function:\global:Invoke-WebRequest -ErrorAction SilentlyContinue }
    $resolvedRoot = [IO.Path]::GetFullPath($testRoot)
    if ([IO.Path]::GetFileName($resolvedRoot) -notmatch '^fargowork-bootstrap-fixture-[0-9a-f]{32}$') { throw 'Refusing unexpected fixture cleanup path.' }
    if (Test-Path -LiteralPath $resolvedRoot) { Remove-Item -LiteralPath $resolvedRoot -Recurse -Force }
}
