param(
    [string]$SdkRoot = $(if ($env:UXP_SDK_ROOT) { $env:UXP_SDK_ROOT } else { Join-Path (Split-Path -Parent $PSScriptRoot) ".deps/bolt-uxp-8dca0be1010070883a4cb3b4de6af38509a4c4e4/src/hybrid" }),
    [string]$BuildDirectory = "build-hybrid",
    [switch]$CoreOnly
)
$ErrorActionPreference = "Stop"
$taskRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $taskRoot
try {
    $taskArgs = @("-S", ".", "-B", $BuildDirectory, "-A", "x64")
    if (-not $CoreOnly) {
        if (-not $SdkRoot -or -not (Test-Path -LiteralPath (Join-Path $SdkRoot "src/api/UxpAddonShared.h"))) {
            throw "Hybrid SDK not found at '$SdkRoot'; run tools/fetch_native_deps.py or pass -SdkRoot."
        }
        $taskArgs += @("-DUXP_SDK_ROOT=$SdkRoot", "-DSAMPS_BUILD_HYBRID=ON", "-DBUILD_TESTING=OFF")
        $taskTargets = @("samps")
    } else {
        $taskArgs += @("-DUXP_SDK_ROOT=", "-DSAMPS_BUILD_HYBRID=OFF", "-DBUILD_TESTING=ON")
        $taskTargets = @("samps_validation", "samps_behavior", "samps_prompt", "samps_postprocess")
    }
    & cmake @taskArgs
    if ($LASTEXITCODE -ne 0) { throw "CMake configure failed." }
    & cmake --build $BuildDirectory --config Release --target @taskTargets -j 2
    if ($LASTEXITCODE -ne 0) { throw "Native compilation failed." }
} finally { Pop-Location }
