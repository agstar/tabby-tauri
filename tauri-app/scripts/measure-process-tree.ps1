param(
  [int]$ProcessId,
  [string]$AppPath,
  [string[]]$AppArguments = @(),
  [string]$Scenario = "process-tree-memory",
  [int]$WarmupSeconds = 20,
  [int]$SampleSeconds = 60,
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "process-tree-lib.ps1")

if (-not $ProcessId -and -not $AppPath) {
  throw "Provide either -ProcessId for an already launched root process or -AppPath for an executable."
}

if (-not $OutputPath) {
  $OutputPath = "..\.omx\plans\$Scenario.json"
}

$normalizedArguments = @()
foreach ($argument in $AppArguments) {
  if ($argument -like "*,*") {
    $normalizedArguments += $argument -split ","
  } else {
    $normalizedArguments += $argument
  }
}

$startedProcess = $null
if ($AppPath) {
  if (-not (Test-Path -LiteralPath $AppPath)) {
    throw "AppPath does not exist: $AppPath"
  }
  if ($normalizedArguments.Count -gt 0) {
    $startedProcess = Start-Process -FilePath $AppPath -ArgumentList $normalizedArguments -PassThru -WindowStyle Hidden
  } else {
    $startedProcess = Start-Process -FilePath $AppPath -PassThru -WindowStyle Hidden
  }
  $ProcessId = $startedProcess.Id
}

try {
  Start-Sleep -Seconds $WarmupSeconds
  $before = Get-Date
  Start-Sleep -Seconds $SampleSeconds
  $after = Get-Date
  $snapshot = Get-ProcessTreeSnapshot -RootProcessId $ProcessId -RoundCpu
  $tree = @($snapshot.tree)

  $result = [ordered]@{
    scenario = $Scenario
    root_pid = $ProcessId
    root_started_at_utc = $snapshot.root_started_at_utc
    app_path = $AppPath
    app_arguments = $normalizedArguments
    warmup_seconds = $WarmupSeconds
    sample_seconds = $SampleSeconds
    sampled_at_start = $before.ToUniversalTime().ToString("o")
    sampled_at_end = $after.ToUniversalTime().ToString("o")
    process_tree = $tree
    total_working_set_mb = [math]::Round((($tree | Measure-Object -Property working_set_mb -Sum).Sum), 2)
    total_private_memory_mb = [math]::Round((($tree | Measure-Object -Property private_memory_mb -Sum).Sum), 2)
    process_count = $tree.Count
    excluded_stale_children = @($snapshot.excluded_stale_children)
    notes = @(
      "Includes the root process and descendant processes.",
      "Descendants with creation timestamps before the root are excluded to avoid PID-reuse contamination.",
      "Use comparable warmup/sample windows when comparing Electron and Tauri.",
      "Short smoke samples are not final performance claims."
    )
  }

  $outputDirectory = Split-Path -Parent $OutputPath
  if ($outputDirectory -and -not (Test-Path -LiteralPath $outputDirectory)) {
    New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
  }
  $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
  $result | ConvertTo-Json -Depth 8
} finally {
  Stop-StartedProcessTree -Process $startedProcess
}
