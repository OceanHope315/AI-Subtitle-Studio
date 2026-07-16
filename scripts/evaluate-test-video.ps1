param(
    [string]$Video = "D:\new project\test\testVideo.mp4",
    [string]$GroundTruth = "D:\new project\test\testVideo.txt",
    [double]$SampleFps = 2.0,
    [double[]]$Roi = @(0.08, 0.52, 0.84, 0.24),
    [switch]$NoWhisper
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root "data\subtitles\test-video"
$arguments = @(
    (Join-Path $root "ai_service\cli.py"),
    $Video,
    "--output", $output,
    "--task-id", "test-video",
    "--sample-fps", $SampleFps,
    "--roi", $Roi[0], $Roi[1], $Roi[2], $Roi[3],
    "--ground-truth", $GroundTruth
)
if ($NoWhisper) {
    $arguments += "--no-whisper"
}

python @arguments
