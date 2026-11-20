$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$config = Get-Content -LiteralPath (Join-Path $root 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$platform = 'x86_64-pc-windows-msvc'
$previousFlags = $env:CARGO_ENCODED_RUSTFLAGS

# Rust diagnostics and panic messages can otherwise embed the build machine's paths.
$buildPaths = @(
    @{ path = $env:USERPROFILE; replacement = '/build/user' }
    @{ path = $env:CARGO_HOME; replacement = '/build/cargo' }
    @{ path = $root; replacement = '/build/margin' }
)
$flags = foreach ($entry in $buildPaths) {
    if ($entry.path) {
        $path = [IO.Path]::GetFullPath($entry.path)
        "--remap-path-prefix=$path=$($entry.replacement)"
        "--remap-path-prefix=$($path.Replace([char]92, [char]47))=$($entry.replacement)"
    }
}

Push-Location -LiteralPath $root
try {
    $env:CARGO_ENCODED_RUSTFLAGS = $flags -join [char]31
    # Windows PowerShell can turn normal Tauri diagnostics on stderr into error records.
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        npm.cmd run tauri build -- --target $platform
        $buildCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($buildCode -ne 0) { throw "Tauri build failed with exit code $buildCode." }

    $target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { 'src-tauri/target' }
    $name = "Margin_$($config.version)_x64-setup.exe"
    $installer = Join-Path $target "$platform/release/bundle/nsis/$name"
    $release = New-Item -ItemType Directory -Force -Path 'release'
    $asset = Join-Path $release.FullName $name
    Copy-Item -LiteralPath $installer -Destination $asset
    $hash = (Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath (Join-Path $release.FullName 'SHA256SUMS.txt') -Encoding ascii -Value "$hash  $name"
} finally {
    $env:CARGO_ENCODED_RUSTFLAGS = $previousFlags
    Pop-Location
}
