Param(
  [int]$Port = 4711,
  [string]$ConvId = 'FR1',
  [string]$Text = 'I try to pick the lock quietly.',
  [int]$Turn = 0
)

$env:PORT = "$Port"
$env:CONV_ID = "$ConvId"
$env:TEXT = "$Text"
$env:TURN = "$Turn"

Write-Host "Probing stream endpoint on port $Port ..."
node scripts/dev_probe_failure_roll.mjs
