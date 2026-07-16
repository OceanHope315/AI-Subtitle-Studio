$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "Installing Python AI service dependencies..."
Push-Location (Join-Path $root "ai_service")
try {
    python -m pip install -r requirements.txt
}
finally {
    Pop-Location
}

Write-Host "Installing Express backend dependencies..."
Push-Location (Join-Path $root "backend")
try {
    npm install
}
finally {
    Pop-Location
}

Write-Host "Installing React frontend dependencies..."
Push-Location (Join-Path $root "frontend")
try {
    npm install
}
finally {
    Pop-Location
}

Write-Host "AI Subtitle Studio dependencies are ready."

