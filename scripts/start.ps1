[CmdletBinding()]
param(
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$venvPython = Join-Path $root "ai_service\.venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $venvPython)) {
    throw "Python environment not found. Run .\scripts\setup.ps1 first."
}

$configFiles = @(
    @{
        Source = Join-Path $root "ai_service\.env.example"
        Target = Join-Path $root "ai_service\.env"
    },
    @{
        Source = Join-Path $root "backend\.env.example"
        Target = Join-Path $root "backend\.env"
    },
    @{
        Source = Join-Path $root "frontend\.env.example"
        Target = Join-Path $root "frontend\.env.local"
    }
)

foreach ($config in $configFiles) {
    if (-not (Test-Path -LiteralPath $config.Target)) {
        Copy-Item -LiteralPath $config.Source -Destination $config.Target
        Write-Host "Created local configuration: $($config.Target)" -ForegroundColor Yellow
    }
}

function Start-StudioTerminal {
    param(
        [Parameter(Mandatory)]
        [string]$Title,

        [Parameter(Mandatory)]
        [string]$Directory,

        [Parameter(Mandatory)]
        [string]$Command
    )

    $terminalScript = @"
`$Host.UI.RawUI.WindowTitle = '$Title'
Set-Location -LiteralPath '$Directory'
Write-Host 'Starting $Title ...' -ForegroundColor Cyan
$Command
"@

    $encoded = [Convert]::ToBase64String(
        [Text.Encoding]::Unicode.GetBytes($terminalScript)
    )

    Start-Process powershell.exe `
        -WindowStyle Normal `
        -ArgumentList @("-NoExit", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encoded)
}

Start-StudioTerminal `
    -Title "AI Subtitle Studio - AI :8000" `
    -Directory (Join-Path $root "ai_service") `
    -Command "& '$venvPython' main.py"

Start-StudioTerminal `
    -Title "AI Subtitle Studio - Backend :3001" `
    -Directory (Join-Path $root "backend") `
    -Command "npm run dev"

Start-StudioTerminal `
    -Title "AI Subtitle Studio - Frontend :5173" `
    -Directory (Join-Path $root "frontend") `
    -Command "npm run dev"

Write-Host ""
Write-Host "Three service terminals have been started." -ForegroundColor Green
Write-Host "AI health:      http://127.0.0.1:8000/health"
Write-Host "Backend health: http://127.0.0.1:3001/api/health"
Write-Host "Frontend:       http://localhost:5173"

if (-not $NoBrowser) {
    Start-Sleep -Seconds 4
    Start-Process "http://localhost:5173"
}
