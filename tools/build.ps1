param(
    [string]$SdkRoot = $env:UXP_SDK_ROOT,
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
            throw "Set -SdkRoot or UXP_SDK_ROOT to an extracted Adobe UXP Hybrid SDK root containing src/api."
        }
        $taskArgs += @("-DUXP_SDK_ROOT=$SdkRoot", "-DSAMPS_BUILD_HYBRID=ON", "-DBUILD_TESTING=OFF")
        $taskTargets = @("samps")
    } else {
        $taskArgs += @("-DUXP_SDK_ROOT=", "-DSAMPS_BUILD_HYBRID=OFF", "-DBUILD_TESTING=ON")
        $taskTargets = @("samps_validation", "samps_behavior", "samps_prompt")
    }
    & cmake @taskArgs
    if ($LASTEXITCODE -ne 0) { throw "CMake configure failed." }
    & cmake --build $BuildDirectory --config Release --target @taskTargets -j 2
    if ($LASTEXITCODE -ne 0) { throw "Native compilation failed." }
} finally { Pop-Location }
