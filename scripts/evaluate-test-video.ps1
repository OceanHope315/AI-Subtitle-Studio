param(
    [Parameter(Mandatory)]
    [string]$Video,

    [string]$GroundTruth,

    [string]$Output,

    [double]$SampleFps = 2.0,

    [double[]]$Roi = @(0.08, 0.52, 0.84, 0.24),

    [switch]$NoWhisper
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$venvPython = Join-Path $root "ai_service\.venv\Scripts\python.exe"
$python = if (Test-Path -LiteralPath $venvPython) { $venvPython } else { "python" }

if (-not (Test-Path -LiteralPath $Video -PathType Leaf)) {
    throw "Video file not found: $Video"
}
if ($GroundTruth -and -not (Test-Path -LiteralPath $GroundTruth -PathType Leaf)) {
    throw "Ground-truth file not found: $GroundTruth"
}
if (-not $Output) {
    $Output = Join-Path $root "data\subtitles\test-video"
}

$arguments = @(
    (Join-Path $root "ai_service\cli.py"),
    $Video,
    "--output", $Output,
    "--task-id", "test-video",
    "--sample-fps", $SampleFps,
    "--roi", $Roi[0], $Roi[1], $Roi[2], $Roi[3]
)
if ($GroundTruth) {
    $arguments += @("--ground-truth", $GroundTruth)
}
if ($NoWhisper) {
    $arguments += "--no-whisper"
}

& $python @arguments
