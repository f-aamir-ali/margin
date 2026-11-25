# Everything a release must pass before build-windows.ps1 runs. Stops at the first failure.
# Usage: powershell -ExecutionPolicy Bypass -File tools/release/check.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location -LiteralPath $root

function Step($name, [scriptblock]$run) {
    Write-Host "== $name" -ForegroundColor Cyan
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $run } finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -ne 0) { throw "$name failed (exit $LASTEXITCODE)." }
}

try {
    $package = (Get-Content package.json -Raw | ConvertFrom-Json).version
    $tauri = (Get-Content src-tauri/tauri.conf.json -Raw | ConvertFrom-Json).version
    $cargo = (Select-String -Path src-tauri/Cargo.toml -Pattern '^version = "(.+)"' | Select-Object -First 1).Matches[0].Groups[1].Value
    if ($package -ne $tauri -or $package -ne $cargo) {
        throw "Versions disagree: package.json $package, tauri.conf.json $tauri, Cargo.toml $cargo."
    }
    Write-Host "Version $package in all three manifests."

    Step 'Clean install from the lockfile' { npm.cmd ci --no-audit --no-fund }
    Step 'Type check' { npx.cmd tsc --noEmit -p . }
    Step 'Frontend tests' { npx.cmd vitest run }
    Step 'Rust tests (locked)' { cargo test --manifest-path src-tauri/Cargo.toml --locked }
    Step 'Third-party notices are current' {
        python tools/release/generate-notices.py
        git diff --quiet -- THIRD_PARTY_NOTICES.txt
        if ($LASTEXITCODE -ne 0) { Write-Host 'THIRD_PARTY_NOTICES.txt changed: review and commit it.' -ForegroundColor Yellow }
    }
    Write-Host 'All checks passed. Next: tools/release/build-windows.ps1, then the e2e suites on a test build.' -ForegroundColor Green
} finally {
    Pop-Location
}
