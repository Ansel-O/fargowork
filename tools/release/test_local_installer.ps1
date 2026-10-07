[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ArtifactDir
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$installer = Join-Path $root 'public\install.ps1'
$candidateDir = (Resolve-Path -LiteralPath $ArtifactDir).Path
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('fargowork-installer-fixture-' + [guid]::NewGuid().ToString('N'))
$oldAppData = $env:APPDATA
$oldLocalAppData = $env:LOCALAPPDATA
$oldUserProfile = $env:USERPROFILE
$oldCodexHome = $env:CODEX_HOME
$oldFault = $global:EmployeeInstallerFault
$oldInstallExit = $global:EmployeeFixtureInstallExit
$oldDoctorExit = $global:EmployeeFixtureDoctorExit
$oldScriptExit = $global:EmployeeInstallerFixtureExitCode
$oldFixtureInstallRoot = $global:EmployeeFixtureInstallRoot
$oldFixtureCalls = $global:EmployeeFixtureCalls
$oldFixtureFailTarget = $global:EmployeeFixtureFailTarget
$oldFixtureLoginExit = $global:EmployeeFixtureLoginExit
$oldFixtureIdentity = $global:EmployeeFixtureIdentity
$oldRegistrationSignal = $global:EmployeeFixtureRegistrationSignal
$oldMoveItemFunction = Get-Item Function:\global:Move-Item -ErrorAction SilentlyContinue
$global:EmployeeInstallerFault = ''
$global:EmployeeFixtureInstallExit = 0
$global:EmployeeFixtureDoctorExit = 3
$global:EmployeeInstallerFixtureExitCode = 0
$script:FixtureJunctions = [System.Collections.Generic.List[string]]::new()

function Assert-Fixture([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Get-FixturePayload([object[]]$Output) {
    $json = @($Output | ForEach-Object { [string]$_ } | Where-Object { $_ -match '^\s*\{.*\}\s*$' } | Select-Object -Last 1)
    if ($json.Count -ne 1) { throw "Installer did not emit one JSONL result: $($Output -join ' | ')" }
    return ($json[0] | ConvertFrom-Json)
}

function Invoke-FixtureInstaller([string]$Roaming, [string]$Mode = 'success', [string]$Fault = '', [string[]]$Targets = @(), [switch]$WithLogin) {
    $env:APPDATA = $Roaming
    $env:LOCALAPPDATA = Join-Path (Split-Path -Parent $Roaming) 'Local'
    $env:USERPROFILE = Split-Path -Parent $Roaming
    $env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex-fixture'
    New-Item -ItemType Directory -Path $env:LOCALAPPDATA, $env:CODEX_HOME -Force | Out-Null
    # No native CLI or host command is executed. Sentinels prove this installer
    # neither registers an MCP nor writes Skills directly in any host directory.
    $hostSentinels = @(
        (Join-Path $env:CODEX_HOME 'config.toml'),
        (Join-Path $env:CODEX_HOME 'skills\foreign\SKILL.md'),
        (Join-Path $env:USERPROFILE '.cursor\mcp.json'),
        (Join-Path $env:USERPROFILE '.claude.json'),
        (Join-Path $env:USERPROFILE '.claude\skills\foreign\SKILL.md'),
        (Join-Path $env:USERPROFILE '.codebuddy\mcp.json')
    )
    $hostHashes = @{}
    foreach ($sentinel in $hostSentinels) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $sentinel) -Force | Out-Null
        if (-not (Test-Path -LiteralPath $sentinel)) { [IO.File]::WriteAllText($sentinel, 'foreign-host-configuration-sentinel') }
        $hostHashes[$sentinel] = (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash
    }
    $global:EmployeeInstallerFault = $Fault
    $global:EmployeeFixtureInstallExit = if ($Mode -in @('install-fail', 'rollback-required', 'mutation-evidence', 'registered-evidence', 'top-level-mutation')) { 41 } else { 0 }
    $global:EmployeeFixtureRegistrationSignal = if ($Mode -in @('rollback-required', 'mutation-evidence', 'registered-evidence', 'top-level-mutation')) { $Mode } else { '' }
    $global:EmployeeFixtureDoctorExit = if ($Mode -eq 'doctor-fail') { 42 } else { 3 }
    $global:EmployeeInstallerFixtureExitCode = -1
    $global:EmployeeFixtureCalls = [System.Collections.Generic.List[object]]::new()
    $global:EmployeeFixtureFailTarget = if ($Mode -eq 'partial-fail') { 'cursor' } else { '' }
    $global:EmployeeFixtureLoginExit = if ($Mode -eq 'login-fail') { 43 } else { 0 }
    $global:EmployeeFixtureIdentity = $Mode -ne 'identity-fail'
    $parameters = @{ Version = $script:FixtureVersion; LocalArtifactDir = $script:FixtureArtifactDir; ServiceIssuer = 'https://employee-fixture.invalid'; OutputJsonl = $true }
    if ($Targets.Count -gt 0) { $parameters.Target = $Targets }
    if ($WithLogin) { $parameters.Login = $true; $parameters.OpenBrowser = 'always' }
    $output = @(& $script:FixtureInstaller @parameters 2>&1)
    $payload = Get-FixturePayload $output
    foreach ($sentinel in $hostSentinels) {
        Assert-Fixture ((Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -eq $hostHashes[$sentinel]) "Installer changed a foreign host configuration or Skill: $sentinel"
    }
    Assert-Fixture (($output -join ' ') -notmatch 'private-fixture-user|private-fixture-corp') 'Installer leaked the login identity payload'
    return [pscustomobject]@{ ExitCode = [int]$global:EmployeeInstallerFixtureExitCode; Payload = $payload; Output = $output; Calls = $global:EmployeeFixtureCalls.ToArray() }
}

function New-OwnedMarker([string]$Path, [string]$Value = 'fargowork-employee-v1') {
    [IO.File]::WriteAllText($Path, $Value, [Text.UTF8Encoding]::new($false))
}

function New-UpdateFixture([string]$Name) {
    $caseRoot = Join-Path $testRoot $Name
    $roaming = Join-Path $caseRoot 'Roaming'
    $employeeRoot = Join-Path $roaming 'FargoWork\employee'
    $bin = Join-Path $employeeRoot 'bin'
    $plugin = Join-Path $employeeRoot 'plugin\fargowork-employee'
    $devRoot = Join-Path $roaming 'FargoWork'
    New-Item -ItemType Directory -Path $bin, $plugin, (Join-Path $devRoot 'plugin\fargowork'), (Join-Path $employeeRoot 'state') -Force | Out-Null
    New-OwnedMarker (Join-Path $employeeRoot '.fargowork-employee-owner')
    New-OwnedMarker (Join-Path $bin '.fargowork-owner')
    New-OwnedMarker (Join-Path $plugin '.fargowork-owner')
    [IO.File]::WriteAllText((Join-Path $bin 'old-client.txt'), 'old-bin-content')
    [IO.File]::WriteAllText((Join-Path $plugin 'old-plugin.txt'), 'old-plugin-content')
    [IO.File]::WriteAllText((Join-Path $plugin 'plugin.json'), '{"name":"fargowork-employee","version":"0.9.0"}')
    [IO.File]::WriteAllText((Join-Path $employeeRoot 'config.json'), '{"profile":"employee-fixture"}')
    [IO.File]::WriteAllBytes((Join-Path $employeeRoot 'state\vault.fixture'), [byte[]]@(7, 11, 19, 23))
    [IO.File]::WriteAllText((Join-Path $employeeRoot 'state\preferences.fixture.json'), '{"personal":"preserve"}')
    [IO.File]::WriteAllText((Join-Path $devRoot 'vault.dpapi'), 'development-vault-sentinel')
    [IO.File]::WriteAllText((Join-Path $devRoot 'plugin\fargowork\dev-plugin.txt'), 'development-plugin-sentinel')
    return [pscustomobject]@{
        Name = $Name
        CaseRoot = $caseRoot
        Roaming = $roaming
        EmployeeRoot = $employeeRoot
        Bin = $bin
        Plugin = $plugin
        StateHashes = @{
            Config = (Get-FileHash -LiteralPath (Join-Path $employeeRoot 'config.json') -Algorithm SHA256).Hash
            EmployeeVault = (Get-FileHash -LiteralPath (Join-Path $employeeRoot 'state\vault.fixture') -Algorithm SHA256).Hash
            Preferences = (Get-FileHash -LiteralPath (Join-Path $employeeRoot 'state\preferences.fixture.json') -Algorithm SHA256).Hash
            DevelopmentVault = (Get-FileHash -LiteralPath (Join-Path $devRoot 'vault.dpapi') -Algorithm SHA256).Hash
            DevelopmentPlugin = (Get-FileHash -LiteralPath (Join-Path $devRoot 'plugin\fargowork\dev-plugin.txt') -Algorithm SHA256).Hash
        }
    }
}

function Assert-OldInstallRestored([object]$Fixture) {
    Assert-Fixture ((Get-Content -LiteralPath (Join-Path $Fixture.Bin 'old-client.txt') -Raw) -eq 'old-bin-content') "$($Fixture.Name): old client was not restored"
    Assert-Fixture ((Get-Content -LiteralPath (Join-Path $Fixture.Plugin 'old-plugin.txt') -Raw) -eq 'old-plugin-content') "$($Fixture.Name): old plugin was not restored"
    Assert-Fixture (Test-Path -LiteralPath (Join-Path $Fixture.Bin '.fargowork-owner')) "$($Fixture.Name): client owner marker was lost"
    Assert-Fixture (Test-Path -LiteralPath (Join-Path $Fixture.Plugin '.fargowork-owner')) "$($Fixture.Name): plugin owner marker was lost"
}

function Assert-ProfileStatePreserved([object]$Fixture) {
    $devRoot = Join-Path $Fixture.Roaming 'FargoWork'
    Assert-Fixture ((Get-FileHash -LiteralPath (Join-Path $Fixture.EmployeeRoot 'config.json') -Algorithm SHA256).Hash -eq $Fixture.StateHashes.Config) "$($Fixture.Name): employee config changed"
    Assert-Fixture ((Get-FileHash -LiteralPath (Join-Path $Fixture.EmployeeRoot 'state\vault.fixture') -Algorithm SHA256).Hash -eq $Fixture.StateHashes.EmployeeVault) "$($Fixture.Name): employee vault changed"
    Assert-Fixture ((Get-FileHash -LiteralPath (Join-Path $Fixture.EmployeeRoot 'state\preferences.fixture.json') -Algorithm SHA256).Hash -eq $Fixture.StateHashes.Preferences) "$($Fixture.Name): personal preferences changed"
    Assert-Fixture ((Get-FileHash -LiteralPath (Join-Path $devRoot 'vault.dpapi') -Algorithm SHA256).Hash -eq $Fixture.StateHashes.DevelopmentVault) "$($Fixture.Name): development vault changed"
    Assert-Fixture ((Get-FileHash -LiteralPath (Join-Path $devRoot 'plugin\fargowork\dev-plugin.txt') -Algorithm SHA256).Hash -eq $Fixture.StateHashes.DevelopmentPlugin) "$($Fixture.Name): development plugin changed"
}

function New-JunctionFixture([string]$Name, [string]$JunctionPath, [string]$TargetPath) {
    New-Item -ItemType Directory -Path $TargetPath -Force | Out-Null
    New-Item -ItemType Junction -Path $JunctionPath -Target $TargetPath | Out-Null
    $script:FixtureJunctions.Add($JunctionPath)
}

function global:Move-Item {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true, Position = 0)] [string]$LiteralPath,
        [Parameter(Mandatory = $true, Position = 1)] [string]$Destination,
        [switch]$Force
    )
    $sourceFull = [IO.Path]::GetFullPath($LiteralPath)
    $destinationFull = [IO.Path]::GetFullPath($Destination)
    $fault = [string]$global:EmployeeInstallerFault
    $installRoot = [string]$global:EmployeeFixtureInstallRoot
    $bin = Join-Path $installRoot 'bin'
    $plugin = Join-Path $installRoot 'plugin\fargowork-employee'
    $isBackup = $destinationFull -match '\\.fargowork-stage-[^\\]+\\backup\\'

    if ($fault -eq 'old-bin-before' -and $sourceFull -ieq $bin -and $isBackup -and $destinationFull -match '\\backup\\bin$') {
        throw 'fixture: old bin move failed before mutation'
    }
    if ($fault -eq 'old-plugin-before' -and $sourceFull -ieq $plugin -and $isBackup -and $destinationFull -match '\\backup\\plugin$') {
        throw 'fixture: old plugin move failed before mutation'
    }
    if ($fault -eq 'restore-plugin' -and $sourceFull -match '\\.fargowork-stage-[^\\]+\\backup\\plugin$' -and $destinationFull -ieq $plugin) {
        throw 'fixture: previous plugin restore failed'
    }

    Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force
    if ($fault -eq 'new-bin-after' -and $sourceFull -match '\\.fargowork-stage-[^\\]+\\new\\bin$' -and $destinationFull -ieq $bin) {
        throw 'fixture: new bin move failed after mutation'
    }
    if ($fault -eq 'new-plugin-after' -and $sourceFull -match '\\.fargowork-stage-[^\\]+\\new\\plugin\\fargowork-employee$' -and $destinationFull -ieq $plugin) {
        throw 'fixture: new plugin move failed after mutation'
    }
}

try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $script:FixtureArtifactDir = Join-Path $testRoot 'artifacts'
    New-Item -ItemType Directory -Path $script:FixtureArtifactDir | Out-Null
    $archives = @(Get-ChildItem -LiteralPath $candidateDir -Filter 'fargowork-employee-v*-windows-x64.zip' -File)
    if ($archives.Count -ne 1) { throw 'ArtifactDir must contain exactly one Windows employee candidate archive.' }
    $outer = $archives[0]
    if ($outer.Name -notmatch '^fargowork-employee-v([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)-windows-x64.zip$') { throw 'Invalid employee candidate version.' }
    $script:FixtureVersion = $Matches[1]
    [IO.Compression.ZipFile]::ExtractToDirectory($outer.FullName, $script:FixtureArtifactDir)

    $scriptText = [IO.File]::ReadAllText($installer, [Text.Encoding]::UTF8).Replace("`r`n", "`n")
    $fixtureCliFunction = @'
function Invoke-EmployeeCli([string]$Exe, [string[]]$Arguments) {
    $command = $Arguments[0]
    $targetIndex = [Array]::IndexOf($Arguments, '--target')
    $selected = if ($targetIndex -ge 0) { $Arguments[$targetIndex + 1] } else { '' }
    $global:EmployeeFixtureCalls.Add(@{ command = $command; target = $selected; arguments = $Arguments })
    $manual = @{ config = @{ mcpServers = @{ 'fargowork-employee' = @{ command = $Exe; args = @('bridge') } } }; skill_path = (Join-Path $script:installRoot 'skills\fargowork-employee\SKILL.md') }
    $client = @{ registered = $selected -ne 'manual'; trusted = 'unknown'; needs_user_action = $true }
    $payload = @{ installed = $true; connected = $null; identity_verified = $false; trusted = 'unknown'; needs_user_action = $true; clients = @{ $selected = $client }; manual_mcp_registration = $manual; skill_path = $manual.skill_path }
    $code = 0
    switch ($command) {
        'install' {
            $code = [int]$global:EmployeeFixtureInstallExit
            if ($selected -eq $global:EmployeeFixtureFailTarget) { $code = 41 }
            $payload.event = if ($code -eq 0) { 'installed' } else { 'error' }
            $payload.installed = $code -eq 0
            $client.registered = $code -eq 0 -and $selected -ne 'manual'
            switch ($global:EmployeeFixtureRegistrationSignal) {
                'rollback-required' { $payload.code = 'registration_rollback_required' }
                'mutation-evidence' { $client.mutation_may_have_happened = $true }
                'registered-evidence' { $client.registered = $true }
                'top-level-mutation' { $payload.mutation_may_have_happened = $true }
            }
        }
        'doctor' { $code = [int]$global:EmployeeFixtureDoctorExit; $payload.event = 'doctor' }
        'login' {
            $code = [int]$global:EmployeeFixtureLoginExit
            $payload = @{ event = if ($code -eq 0) { 'logged_in' } else { 'error' }; connected = $code -eq 0; identity = @{ userid = 'private-fixture-user'; corp_id = 'private-fixture-corp' } }
        }
        'status' {
            $payload.event = 'status'; $payload.identity_verified = [bool]$global:EmployeeFixtureIdentity
            $payload.connected = $payload.identity_verified; $code = 3
            $payload.identity = @{ userid = 'private-fixture-user'; corp_id = 'private-fixture-corp' }
        }
        default { throw "Unexpected fixture CLI command: $command" }
    }
    return [pscustomobject]@{ ExitCode = $code; Payload = [pscustomobject]$payload }
}
'@.Replace("`r`n", "`n").TrimEnd([char]10)
    $installerAst = [System.Management.Automation.Language.Parser]::ParseInput($scriptText, [ref]$null, [ref]$null)
    $cliFunctions = @($installerAst.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-EmployeeCli' }, $true))
    if ($cliFunctions.Count -ne 1) { throw 'Could not identify the only native CLI invocation function for fixture isolation.' }
    $extent = $cliFunctions[0].Extent
    # Exercise the real JSONL/exit-code capture and Windows -File comma argument
    # transport with a harmless child script, never the candidate executable.
    . ([scriptblock]::Create($extent.Text.Replace('function Invoke-EmployeeCli', 'function Invoke-NativeFixtureCli')))
    $nativeFixtureDir = Join-Path $testRoot 'native CLI space'
    New-Item -ItemType Directory -Path $nativeFixtureDir | Out-Null
    $nativeFixture = Join-Path $nativeFixtureDir 'fake-native.ps1'
    $nativeFixtureText = @'
param([string]$Target)
Write-Output ('{"event":"doctor","installed":true,"target":"' + $Target + '","path":"C:\\' + '\u6d4b\u8bd5 space\\fargowork.exe"}')
exit 3
'@
    [IO.File]::WriteAllText($nativeFixture, $nativeFixtureText, [Text.UTF8Encoding]::new($true))
    $nativeReply = Invoke-NativeFixtureCli (Get-Command powershell.exe).Source @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $nativeFixture, '-Target', 'cursor,codex')
    Assert-Fixture ($nativeReply.ExitCode -eq 3 -and $nativeReply.Payload.event -eq 'doctor' -and $nativeReply.Payload.target -eq 'cursor,codex') 'Native JSONL/exit-code capture or Windows comma target transport failed'
    $expectedUnicodePath = 'C:\' + [char]0x6d4b + [char]0x8bd5 + ' space\fargowork.exe'
    Assert-Fixture ($nativeReply.Payload.path -ceq $expectedUnicodePath) 'ASCII-escaped native JSONL did not preserve Unicode paths'
    $scriptText = $scriptText.Remove($extent.StartOffset, $extent.EndOffset - $extent.StartOffset).Insert($extent.StartOffset, $fixtureCliFunction)
    $scriptText = $scriptText.Replace('exit 0', '$global:EmployeeInstallerFixtureExitCode = 0; return')
    $scriptText = $scriptText.Replace('exit 4', '$global:EmployeeInstallerFixtureExitCode = 4; return')
    $script:FixtureInstaller = Join-Path $testRoot 'install-fixture.ps1'
    [IO.File]::WriteAllText($script:FixtureInstaller, $scriptText, [Text.UTF8Encoding]::new($false))

    # Check checksum rejection without modifying the source candidate.
    $tamperDir = Join-Path $testRoot 'tampered-artifacts'
    Copy-Item -LiteralPath $script:FixtureArtifactDir -Destination $tamperDir -Recurse
    $tamperZip = Join-Path $tamperDir "fargowork-cli-v$($script:FixtureVersion)-windows-x64.zip"
    $tamperBytes = [IO.File]::ReadAllBytes($tamperZip)
    $tamperBytes[100] = $tamperBytes[100] -bxor 1
    [IO.File]::WriteAllBytes($tamperZip, $tamperBytes)
    $env:APPDATA = Join-Path $testRoot 'tamper-Roaming'
    $global:EmployeeInstallerFixtureExitCode = -1
    $tamperOutput = @(& $script:FixtureInstaller -Version $script:FixtureVersion -LocalArtifactDir $tamperDir -ServiceIssuer 'https://employee-fixture.invalid' -DryRun -OutputJsonl 2>&1)
    $tamperResult = Get-FixturePayload $tamperOutput
    Assert-Fixture ($global:EmployeeInstallerFixtureExitCode -eq 4 -and $tamperResult.code -eq 'install_failed') 'checksum tampering was not rejected'

    $cases = @(
        @{ Name = 'old-bin-move'; Mode = 'success'; Fault = 'old-bin-before'; Expected = 'install_failed' },
        @{ Name = 'old-plugin-move'; Mode = 'success'; Fault = 'old-plugin-before'; Expected = 'install_failed' },
        @{ Name = 'new-bin-partial-move'; Mode = 'success'; Fault = 'new-bin-after'; Expected = 'install_failed' },
        @{ Name = 'new-plugin-partial-move'; Mode = 'success'; Fault = 'new-plugin-after'; Expected = 'install_failed' },
        @{ Name = 'registration-failure'; Mode = 'install-fail'; Fault = ''; Expected = 'install_failed' },
        @{ Name = 'doctor-failure'; Mode = 'doctor-fail'; Fault = ''; Expected = 'post_install_failed' }
    )
    foreach ($case in $cases) {
        $fixture = New-UpdateFixture $case.Name
        $global:EmployeeFixtureInstallRoot = $fixture.EmployeeRoot
        $result = Invoke-FixtureInstaller $fixture.Roaming $case.Mode $case.Fault
        Assert-Fixture ($result.ExitCode -eq 4 -and $result.Payload.code -eq $case.Expected) "$($case.Name): expected installer rollback failure result"
        if ($case.Mode -eq 'doctor-fail') {
            Assert-Fixture ($result.Payload.installed -and (Test-Path -LiteralPath (Join-Path $fixture.Bin 'fargowork.exe'))) 'A diagnostic failure removed an executable already referenced by installed clients'
        } else { Assert-OldInstallRestored $fixture }
        Assert-ProfileStatePreserved $fixture
        Assert-Fixture (@(Get-ChildItem -LiteralPath $fixture.EmployeeRoot -Directory -Filter '.fargowork-stage-*').Count -eq 0) "$($case.Name): recovered stage was not cleaned"
    }

    $restoreFixture = New-UpdateFixture 'restore-failure'
    $global:EmployeeFixtureInstallRoot = $restoreFixture.EmployeeRoot
    $restoreResult = Invoke-FixtureInstaller $restoreFixture.Roaming 'install-fail' 'restore-plugin'
    Assert-Fixture ($restoreResult.ExitCode -eq 4 -and $restoreResult.Payload.code -eq 'install_failed_recovery_required') 'restore failure did not report recoverable state'
    Assert-Fixture ([string]$restoreResult.Payload.recovery_path -match '\\.fargowork-stage-') 'restore failure did not expose the retained recovery path'
    Assert-Fixture (Test-Path -LiteralPath (Join-Path $restoreFixture.Bin 'old-client.txt')) 'restore failure did not keep restored client backup'
    Assert-Fixture (Test-Path -LiteralPath (Join-Path $restoreResult.Payload.recovery_path 'backup\plugin\old-plugin.txt')) 'restore failure deleted the previous plugin backup'
    Assert-ProfileStatePreserved $restoreFixture

    $successFixture = New-UpdateFixture 'successful-update'
    $global:EmployeeFixtureInstallRoot = $successFixture.EmployeeRoot
    $successResult = Invoke-FixtureInstaller $successFixture.Roaming 'success' ''
    Assert-Fixture ($successResult.ExitCode -eq 0 -and $successResult.Payload.event -eq 'installed' -and $successResult.Payload.status -eq 'needs_user_action') 'successful update did not commit with the expected doctor status'
    Assert-Fixture ((Get-Content -LiteralPath (Join-Path $successFixture.Bin '.fargowork-owner') -Raw) -eq 'fargowork-employee-v1') 'successful update did not install the client owner marker'
    Assert-Fixture ((Get-Content -LiteralPath (Join-Path $successFixture.Plugin '.fargowork-owner') -Raw) -eq 'fargowork-employee-v1') 'successful update did not install the plugin owner marker'
    Assert-Fixture (Test-Path -LiteralPath (Join-Path $successFixture.Bin 'fargowork.exe')) 'successful update did not place the client executable'
    Assert-Fixture (Test-Path -LiteralPath (Join-Path $successFixture.Plugin 'plugin.json')) 'successful update did not place the employee plugin'
    Assert-ProfileStatePreserved $successFixture
    Assert-Fixture (@(Get-ChildItem -LiteralPath $successFixture.EmployeeRoot -Directory -Filter '.fargowork-stage-*').Count -eq 0) 'successful update did not remove its backup stage'
    Assert-Fixture ($null -eq $successResult.Payload.connected -and -not $successResult.Payload.identity_verified) 'Installation claimed an authenticated connection without identity verification'
    Assert-Fixture (@($successResult.Calls | Where-Object { $_.command -in @('login', 'status') }).Count -eq 0) 'Default installation performed login or identity queries'
    Assert-Fixture (@($successResult.Payload.targets).Count -eq 1 -and $successResult.Payload.targets[0].target -eq 'manual') 'Default installation did not select manual only'
    Assert-Fixture ([IO.Path]::IsPathRooted($successResult.Payload.manual_mcp_registration.config.mcpServers.'fargowork-employee'.command) -and $successResult.Payload.manual_mcp_registration.config.mcpServers.'fargowork-employee'.args[0] -eq 'bridge') 'Manual configuration is not an absolute standard stdio command'
    Assert-Fixture ([IO.Path]::IsPathRooted($successResult.Payload.skill_path)) 'Manual Skill path is not absolute'

    foreach ($knownTarget in @('codex', 'cursor', 'workbuddy', 'claude-code')) {
        $hostFixture = New-UpdateFixture ('target-' + $knownTarget)
        $global:EmployeeFixtureInstallRoot = $hostFixture.EmployeeRoot
        $hostResult = Invoke-FixtureInstaller $hostFixture.Roaming 'success' '' @($knownTarget)
        Assert-Fixture ($hostResult.ExitCode -eq 0 -and $hostResult.Payload.targets[0].target -eq $knownTarget) "Target was not passed accurately to the CLI: $knownTarget"
        Assert-ProfileStatePreserved $hostFixture
    }

    $multiple = New-UpdateFixture 'multiple-targets'
    $global:EmployeeFixtureInstallRoot = $multiple.EmployeeRoot
    $multiResult = Invoke-FixtureInstaller $multiple.Roaming 'success' '' @('cursor,codex', 'cursor', 'claude-code')
    Assert-Fixture ($multiResult.ExitCode -eq 0 -and ($multiResult.Payload.targets.target -join ',') -eq 'cursor,codex,claude-code') 'Comma/array multi-target selection did not normalize or deduplicate'
    Assert-Fixture (@($multiResult.Calls | Where-Object { $_.command -eq 'install' }).Count -eq 3) 'Multi-target install did not call each selected adapter once'
    Assert-ProfileStatePreserved $multiple

    $partial = New-UpdateFixture 'partial-target-failure'
    $global:EmployeeFixtureInstallRoot = $partial.EmployeeRoot
    $partialResult = Invoke-FixtureInstaller $partial.Roaming 'partial-fail' '' @('codex', 'cursor', 'manual')
    Assert-Fixture ($partialResult.ExitCode -eq 4 -and $partialResult.Payload.installed -and $partialResult.Payload.code -eq 'post_install_failed') 'Partial host failure did not return nonzero while retaining successful installations'
    Assert-Fixture (($partialResult.Payload.targets | Where-Object { $_.target -eq 'cursor' }).status -eq 'error') 'Partial failure was not attributed to the failed target'
    Assert-Fixture (Test-Path -LiteralPath (Join-Path $partial.Bin 'fargowork.exe')) 'Partial host failure rolled back the executable used by successful targets'
    Assert-Fixture (-not (Test-Path -LiteralPath (Join-Path $partial.Bin 'old-client.txt'))) 'Partial host failure restored the previous incompatible client'
    Assert-ProfileStatePreserved $partial

    foreach ($signal in @('rollback-required', 'mutation-evidence', 'registered-evidence', 'top-level-mutation')) {
        $registrationFixture = New-UpdateFixture ('failed-registration-' + $signal)
        $global:EmployeeFixtureInstallRoot = $registrationFixture.EmployeeRoot
        $registrationResult = Invoke-FixtureInstaller $registrationFixture.Roaming $signal '' @('codex')
        Assert-Fixture ($registrationResult.ExitCode -eq 4 -and $registrationResult.Payload.installed -and $registrationResult.Payload.code -eq 'post_install_failed') "$signal`: possibly registered host failure did not retain the package with nonzero exit"
        Assert-Fixture ($registrationResult.Payload.targets[0].requires_manual_recovery -and -not $registrationResult.Payload.targets[0].installed -and -not $registrationResult.Payload.targets[0].rolled_back) "$signal`: uncertain host recovery or installation status was not reported accurately"
        Assert-Fixture (Test-Path -LiteralPath (Join-Path $registrationFixture.Bin 'fargowork.exe')) "$signal`: failed registration removed an executable which may already be referenced"
        Assert-Fixture (-not (Test-Path -LiteralPath (Join-Path $registrationFixture.Bin 'old-client.txt'))) "$signal`: installer restored the previous executable despite host mutation evidence"
        Assert-Fixture ((Get-Content -LiteralPath (Join-Path $registrationFixture.Plugin 'plugin.json') -Raw | ConvertFrom-Json).version -eq $script:FixtureVersion) "$signal`: possibly referenced plugin was rolled back"
        Assert-ProfileStatePreserved $registrationFixture
    }

    foreach ($loginMode in @('success', 'login-fail', 'identity-fail')) {
        $loginFixture = New-UpdateFixture ('login-' + $loginMode)
        $global:EmployeeFixtureInstallRoot = $loginFixture.EmployeeRoot
        $loginResult = Invoke-FixtureInstaller $loginFixture.Roaming $loginMode '' @('manual', 'codex') -WithLogin
        Assert-Fixture (@($loginResult.Calls | Where-Object { $_.command -eq 'login' }).Count -eq 1) "$loginMode`: installer did not perform exactly one login"
        $loginCall = @($loginResult.Calls | Where-Object { $_.command -eq 'login' })[0]
        Assert-Fixture (($loginCall.arguments -join ' ') -match '--browser always') "$loginMode`: browser preference was not passed to the CLI"
        if ($loginMode -eq 'success') {
            Assert-Fixture ($loginResult.ExitCode -eq 0 -and $loginResult.Payload.connected -and $loginResult.Payload.identity_verified) 'Successful login did not require actual status identity verification'
            Assert-Fixture (@($loginResult.Calls | Where-Object { $_.command -eq 'status' }).Count -eq 2) 'Login did not verify identity for each target'
        } else {
            Assert-Fixture ($loginResult.ExitCode -eq 4 -and $loginResult.Payload.installed -and -not $loginResult.Payload.connected -and -not $loginResult.Payload.identity_verified) "$loginMode`: post-install authentication failure was misreported"
            Assert-Fixture (Test-Path -LiteralPath (Join-Path $loginFixture.Bin 'fargowork.exe')) "$loginMode`: authentication failure rolled back installed files"
        }
        Assert-ProfileStatePreserved $loginFixture
    }

    $invalid = New-UpdateFixture 'invalid-target'
    $global:EmployeeFixtureInstallRoot = $invalid.EmployeeRoot
    $invalidResult = Invoke-FixtureInstaller $invalid.Roaming 'success' '' @('foreign-host')
    Assert-Fixture ($invalidResult.ExitCode -eq 4 -and $invalidResult.Calls.Count -eq 0) 'Unknown target was not rejected before mutation or native execution'
    Assert-OldInstallRestored $invalid
    Assert-ProfileStatePreserved $invalid

    $freshRoaming = Join-Path $testRoot 'fresh-install\Roaming'
    New-Item -ItemType Directory -Path $freshRoaming -Force | Out-Null
    $global:EmployeeFixtureInstallRoot = Join-Path $freshRoaming 'FargoWork\employee'
    $freshResult = Invoke-FixtureInstaller $freshRoaming 'success' ''
    Assert-Fixture ($freshResult.ExitCode -eq 0 -and $freshResult.Payload.event -eq 'installed') 'first install did not create the isolated employee profile'
    Assert-Fixture (Test-Path -LiteralPath (Join-Path $global:EmployeeFixtureInstallRoot '.fargowork-employee-owner')) 'first install did not mark the employee profile'
    Assert-Fixture (Test-Path -LiteralPath (Join-Path $global:EmployeeFixtureInstallRoot 'plugin\fargowork-employee\plugin.json')) 'first install did not place the employee plugin'

    # Unmarked roots and unmarked replacement targets must be preserved.
    $foreignRoot = Join-Path $testRoot 'foreign-root\Roaming'
    $foreignEmployee = Join-Path $foreignRoot 'FargoWork\employee'
    New-Item -ItemType Directory -Path $foreignEmployee | Out-Null
    [IO.File]::WriteAllText((Join-Path $foreignEmployee 'keep.txt'), 'foreign-root-sentinel')
    $global:EmployeeFixtureInstallRoot = $foreignEmployee
    $foreignResult = Invoke-FixtureInstaller $foreignRoot 'success' ''
    Assert-Fixture ($foreignResult.ExitCode -eq 4 -and $foreignResult.Payload.code -eq 'install_failed') 'installer accepted a non-empty unowned employee root'
    Assert-Fixture ((Get-Content -LiteralPath (Join-Path $foreignEmployee 'keep.txt') -Raw) -eq 'foreign-root-sentinel') 'installer changed an unowned employee root'

    $foreignBin = Join-Path $testRoot 'foreign-bin\Roaming'
    $foreignEmployeeBin = Join-Path $foreignBin 'FargoWork\employee'
    New-Item -ItemType Directory -Path (Join-Path $foreignEmployeeBin 'bin'), (Join-Path $foreignEmployeeBin 'plugin\fargowork-employee') -Force | Out-Null
    New-OwnedMarker (Join-Path $foreignEmployeeBin '.fargowork-employee-owner')
    New-OwnedMarker (Join-Path $foreignEmployeeBin 'plugin\fargowork-employee\.fargowork-owner')
    [IO.File]::WriteAllText((Join-Path $foreignEmployeeBin 'bin\keep.txt'), 'foreign-bin-sentinel')
    $global:EmployeeFixtureInstallRoot = $foreignEmployeeBin
    $foreignBinResult = Invoke-FixtureInstaller $foreignBin 'success' ''
    Assert-Fixture ($foreignBinResult.ExitCode -eq 4 -and (Test-Path -LiteralPath (Join-Path $foreignEmployeeBin 'bin\keep.txt'))) 'installer changed an unowned bin target'

    $foreignPlugin = Join-Path $testRoot 'foreign-plugin\Roaming'
    $foreignEmployeePlugin = Join-Path $foreignPlugin 'FargoWork\employee'
    New-Item -ItemType Directory -Path (Join-Path $foreignEmployeePlugin 'bin'), (Join-Path $foreignEmployeePlugin 'plugin\fargowork-employee') -Force | Out-Null
    New-OwnedMarker (Join-Path $foreignEmployeePlugin '.fargowork-employee-owner')
    New-OwnedMarker (Join-Path $foreignEmployeePlugin 'bin\.fargowork-owner')
    [IO.File]::WriteAllText((Join-Path $foreignEmployeePlugin 'plugin\fargowork-employee\keep.txt'), 'foreign-plugin-sentinel')
    $global:EmployeeFixtureInstallRoot = $foreignEmployeePlugin
    $foreignPluginResult = Invoke-FixtureInstaller $foreignPlugin 'success' ''
    Assert-Fixture ($foreignPluginResult.ExitCode -eq 4 -and (Test-Path -LiteralPath (Join-Path $foreignEmployeePlugin 'plugin\fargowork-employee\keep.txt'))) 'installer changed an unowned plugin target'

    $parentJunctionRoot = Join-Path $testRoot 'parent-junction\Roaming'
    $parentEmployee = Join-Path $parentJunctionRoot 'FargoWork\employee'
    New-Item -ItemType Directory -Path (Join-Path $parentEmployee 'bin') -Force | Out-Null
    New-OwnedMarker (Join-Path $parentEmployee '.fargowork-employee-owner')
    New-OwnedMarker (Join-Path $parentEmployee 'bin\.fargowork-owner')
    [IO.File]::WriteAllText((Join-Path $parentEmployee 'bin\keep.txt'), 'junction-parent-client')
    $outsidePlugin = Join-Path $testRoot 'parent-junction-outside'
    New-JunctionFixture 'plugin-parent-junction' (Join-Path $parentEmployee 'plugin') $outsidePlugin
    [IO.File]::WriteAllText((Join-Path $outsidePlugin 'outside-sentinel.txt'), 'outside-untouched')
    $global:EmployeeFixtureInstallRoot = $parentEmployee
    $parentJunctionResult = Invoke-FixtureInstaller $parentJunctionRoot 'success' ''
    Assert-Fixture ($parentJunctionResult.ExitCode -eq 4) 'installer accepted a junction in the employee plugin parent chain'
    Assert-Fixture ((Get-Content -LiteralPath (Join-Path $parentEmployee 'bin\keep.txt') -Raw) -eq 'junction-parent-client') 'installer moved the client before rejecting a parent junction'
    Assert-Fixture ((Get-Content -LiteralPath (Join-Path $outsidePlugin 'outside-sentinel.txt') -Raw) -eq 'outside-untouched') 'installer changed content beyond the employee parent junction'

    $rootJunctionBase = Join-Path $testRoot 'root-junction'
    $rootJunctionTarget = Join-Path $rootJunctionBase 'target'
    $rootJunction = Join-Path $rootJunctionBase 'Roaming'
    New-Item -ItemType Directory -Path $rootJunctionBase, $rootJunctionTarget -Force | Out-Null
    New-JunctionFixture 'appdata-junction' $rootJunction $rootJunctionTarget
    $outsideEmployee = Join-Path $rootJunctionTarget 'FargoWork\employee'
    New-Item -ItemType Directory -Path (Join-Path $outsideEmployee 'bin') -Force | Out-Null
    New-OwnedMarker (Join-Path $outsideEmployee '.fargowork-employee-owner')
    New-OwnedMarker (Join-Path $outsideEmployee 'bin\.fargowork-owner')
    [IO.File]::WriteAllText((Join-Path $outsideEmployee 'bin\keep.txt'), 'junction-root-client')
    $global:EmployeeFixtureInstallRoot = $outsideEmployee
    $rootJunctionResult = Invoke-FixtureInstaller $rootJunction 'success' ''
    Assert-Fixture ($rootJunctionResult.ExitCode -eq 4) 'installer accepted a junction in the APPDATA ancestor chain'
    Assert-Fixture ((Get-Content -LiteralPath (Join-Path $outsideEmployee 'bin\keep.txt') -Raw) -eq 'junction-root-client') 'installer changed content beyond the APPDATA junction'

    Write-Output 'employee installer fixture: PASS (manual default; five targets; comma/array dedup; partial host failure; optional single login with identity verification; checksum rejection; old/new move rollback; diagnostic failure retains installed client; retained recovery; ownership/junction rejection; foreign host config/Skills and personal state preserved)'
} finally {
    $env:APPDATA = $oldAppData
    $env:LOCALAPPDATA = $oldLocalAppData
    $env:USERPROFILE = $oldUserProfile
    $env:CODEX_HOME = $oldCodexHome
    $global:EmployeeInstallerFault = $oldFault
    $global:EmployeeFixtureInstallExit = $oldInstallExit
    $global:EmployeeFixtureDoctorExit = $oldDoctorExit
    $global:EmployeeInstallerFixtureExitCode = $oldScriptExit
    $global:EmployeeFixtureInstallRoot = $oldFixtureInstallRoot
    $global:EmployeeFixtureCalls = $oldFixtureCalls
    $global:EmployeeFixtureFailTarget = $oldFixtureFailTarget
    $global:EmployeeFixtureLoginExit = $oldFixtureLoginExit
    $global:EmployeeFixtureIdentity = $oldFixtureIdentity
    $global:EmployeeFixtureRegistrationSignal = $oldRegistrationSignal
    if ($oldMoveItemFunction) {
        Set-Item Function:\global:Move-Item -Value $oldMoveItemFunction.ScriptBlock -Force
    } else {
        Remove-Item Function:\global:Move-Item -ErrorAction SilentlyContinue
    }
    $resolvedRoot = [IO.Path]::GetFullPath($testRoot).TrimEnd([char]92)
    if ([IO.Path]::GetFileName($resolvedRoot) -notmatch '^fargowork-installer-fixture-[0-9a-f]{32}$') { throw 'Refusing unexpected installer fixture cleanup path.' }
    foreach ($junction in @($script:FixtureJunctions | Sort-Object Length -Descending)) {
        $resolvedJunction = [IO.Path]::GetFullPath($junction)
        if (-not $resolvedJunction.StartsWith($resolvedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing junction cleanup outside this installer fixture.' }
        if (Test-Path -LiteralPath $resolvedJunction) {
            $item = Get-Item -LiteralPath $resolvedJunction -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { throw 'Fixture junction was replaced; retaining test recovery material.' }
            # Non-recursive Directory.Delete removes the junction itself. PS5.1
            # Remove-Item can throw a NullReferenceException on junctions.
            [IO.Directory]::Delete($resolvedJunction)
        }
    }
    if (Test-Path -LiteralPath $resolvedRoot) { Remove-Item -LiteralPath $resolvedRoot -Recurse -Force }
}
