[CmdletBinding()]
param(
    [switch]$WithWhisperX
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$aiDirectory = Join-Path $root "ai_service"
$venvDirectory = Join-Path $aiDirectory ".venv"
$venvPython = Join-Path $venvDirectory "Scripts\python.exe"

function Assert-Command {
    param(
        [Parameter(Mandatory)]
        [string]$Name
    )

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found on PATH."
    }
}

function Copy-ExampleConfiguration {
    param(
        [Parameter(Mandatory)]
        [string]$Source,

        [Parameter(Mandatory)]
        [string]$Destination
    )

    if (-not (Test-Path -LiteralPath $Destination)) {
        Copy-Item -LiteralPath $Source -Destination $Destination
        Write-Host "Created local configuration: $Destination" -ForegroundColor Yellow
    }
}

Assert-Command -Name "python"
Assert-Command -Name "node"
Assert-Command -Name "npm"

$pythonVersion = & python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
if ($pythonVersion -ne "3.12") {
    throw "Python 3.12 is required; found Python $pythonVersion."
}

$nodeMajor = [int]((& node --version).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 20) {
    throw "Node.js 20 or newer is required; found $(& node --version)."
}

if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Host "Creating Python virtual environment..."
    & python -m venv $venvDirectory
}

Write-Host "Installing AI service dependencies..."
& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install -r (Join-Path $aiDirectory "requirements.txt")
if ($WithWhisperX) {
    Write-Host "Installing optional WhisperX dependencies..."
    & $venvPython -m pip install -r (Join-Path $aiDirectory "requirements-whisperx.txt")
}

Write-Host "Installing backend dependencies from package-lock.json..."
Push-Location (Join-Path $root "backend")
try {
    npm ci
}
finally {
    Pop-Location
}

Write-Host "Installing frontend dependencies from package-lock.json..."
Push-Location (Join-Path $root "frontend")
try {
    npm ci
}
finally {
    Pop-Location
}

Copy-ExampleConfiguration `
    -Source (Join-Path $aiDirectory ".env.example") `
    -Destination (Join-Path $aiDirectory ".env")
Copy-ExampleConfiguration `
    -Source (Join-Path $root "backend\.env.example") `
    -Destination (Join-Path $root "backend\.env")
Copy-ExampleConfiguration `
    -Source (Join-Path $root "frontend\.env.example") `
    -Destination (Join-Path $root "frontend\.env.local")

Write-Host ""
Write-Host "AI Subtitle Studio dependencies are ready." -ForegroundColor Green
Write-Host "Start all services with: .\scripts\start.ps1"
