Param(
  [int]$Port = 4711
)

$env:PORT = "$Port"
$env:FAILROLL_ENABLED = '1'
$env:FAILROLL_STYLE = 'diegetic'
$env:FAILROLL_SSE_VERBOSE = '1'
$env:FAILROLL_RISK_REGEX = '(sneak|pick|steal|dodge|parry|shoot|hack|bluff|deceiv|intimidat|climb|jump|lock)'

$env:COMPLICATION_ENABLED = '1'
$env:COMPLICATION_BAND = '5'
$env:COMPLICATION_FACT_WEIGHT = '0.2'
$env:COMPLICATION_SSE_VERBOSE = '1'

$env:BEAT_DELTA_SUCCESS_FALLING = '-0.07'
$env:BEAT_DELTA_SUCCESS_RISING = '-0.02'
$env:BEAT_DELTA_FAIL_RISING = '0.08'
$env:BEAT_DELTA_FAIL_CLIMAX = '0.10'
$env:BEAT_DELTA_FAIL_FALLING = '0.04'

Write-Host "Starting service on port $Port with complications enabled..."
node scripts/service.js
