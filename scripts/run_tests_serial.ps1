param(
  [string]$Root = "$PSScriptRoot/.."
)

$ErrorActionPreference = 'Stop'
# Ensure default skew guard for distributed limiter fairness tests
if (-not $env:RL_MAX_SKEW_MS -or $env:RL_MAX_SKEW_MS -eq '') { $env:RL_MAX_SKEW_MS = '250' }
$root = Resolve-Path $Root
$tests = Get-ChildItem -Path "$root/scripts/tests" -Filter '*.test.mjs' | Sort-Object Name
Write-Host 'Running tests serially with spec reporter...'
foreach ($t in $tests) {
  Write-Host "`n--- Running $($t.Name) ---`n"
  node --test --test-reporter=spec "$($t.FullName)"
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Test failed: $($t.Name)" -ForegroundColor Red
    exit $LASTEXITCODE
  }
}

Write-Host "\nAll tests completed successfully."
