param(
  [int]$ProcessId,
  [string]$AppPath,
  [string[]]$AppArguments = @(),
  [string]$Scenario = "tauri-idle-cpu",
  [int]$WarmupSeconds = 20,
  [int]$SampleSeconds = 60,
  [int]$ExpectedTabs = 0,
  [string]$OutputPath = "..\..\.omx\plans\idle-cpu-tabby-tauri-windows.json"
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "process-tree-lib.ps1")

function Read-AutomationReport {
  param([int]$RootProcessId)

  $path = Join-Path ([IO.Path]::GetTempPath()) "tabby-tauri-perf-automation-$RootProcessId.json"
  if (Test-Path -LiteralPath $path) {
    return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  }
  return $null
}

if (-not $ProcessId -and -not $AppPath) {
  throw "Provide either -ProcessId for an already launched root process or -AppPath for an executable."
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
  Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Filter "tabby-tauri-perf-automation-*.json" -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
  if ($normalizedArguments.Count -gt 0) {
    $startedProcess = Start-Process -FilePath $AppPath -ArgumentList $normalizedArguments -PassThru -WindowStyle Hidden
  } else {
    $startedProcess = Start-Process -FilePath $AppPath -PassThru -WindowStyle Hidden
  }
  $ProcessId = $startedProcess.Id
}

try {
  Start-Sleep -Seconds $WarmupSeconds
  $automationReport = Read-AutomationReport -RootProcessId $ProcessId
  $automationVerified = $false
  if ($ExpectedTabs -gt 0 -and $automationReport) {
    $automationVerified = (
      [int]$automationReport.requested_tabs -eq $ExpectedTabs -and
      [int]$automationReport.opened_tabs -eq $ExpectedTabs -and
      @($automationReport.errors).Count -eq 0
    )
  } elseif ($ExpectedTabs -eq 0) {
    $automationVerified = $true
  }

  $startTime = Get-Date
  $startSnapshot = Get-ProcessTreeSnapshot -RootProcessId $ProcessId
  $startTree = @($startSnapshot.tree)
  Start-Sleep -Seconds $SampleSeconds
  $endTime = Get-Date
  $endSnapshot = Get-ProcessTreeSnapshot -RootProcessId $ProcessId
  $endTree = @($endSnapshot.tree)

  $startCpuByPid = @{}
  foreach ($proc in $startTree) {
    $startCpuByPid[[int]$proc.pid] = [double]$proc.cpu_seconds
  }

  $cpuDeltaSeconds = 0.0
  $processDeltas = @()
  foreach ($proc in $endTree) {
    $startCpu = if ($startCpuByPid.ContainsKey([int]$proc.pid)) { [double]$startCpuByPid[[int]$proc.pid] } else { 0.0 }
    $delta = [Math]::Max(0.0, ([double]$proc.cpu_seconds) - $startCpu)
    $cpuDeltaSeconds += $delta
    $processDeltas += [pscustomobject][ordered]@{
      pid = $proc.pid
      name = $proc.name
      cpu_delta_seconds = [math]::Round($delta, 4)
      working_set_mb = $proc.working_set_mb
      private_memory_mb = $proc.private_memory_mb
    }
  }

  $elapsedSeconds = [Math]::Max(0.001, ($endTime - $startTime).TotalSeconds)
  $logicalProcessors = [Math]::Max(1, [Environment]::ProcessorCount)
  $averageCpuPercent = [math]::Round(($cpuDeltaSeconds / ($elapsedSeconds * $logicalProcessors)) * 100, 3)

  $result = [ordered]@{
    scenario = $Scenario
    status = if ($ExpectedTabs -gt 0 -and -not $automationVerified) { "sampled-with-unverified-automation" } else { "sampled" }
    generated_at = (Get-Date).ToUniversalTime().ToString("o")
    root_pid = $ProcessId
    root_started_at_utc = $endSnapshot.root_started_at_utc
    app_path = $AppPath
    app_arguments = $normalizedArguments
    expected_tabs = $ExpectedTabs
    warmup_seconds = $WarmupSeconds
    sample_seconds = $SampleSeconds
    sampled_at_start = $startTime.ToUniversalTime().ToString("o")
    sampled_at_end = $endTime.ToUniversalTime().ToString("o")
    elapsed_seconds = [math]::Round($elapsedSeconds, 3)
    logical_processors = $logicalProcessors
    total_cpu_delta_seconds = [math]::Round($cpuDeltaSeconds, 4)
    average_cpu_percent = $averageCpuPercent
    total_working_set_mb = [math]::Round((($endTree | Measure-Object -Property working_set_mb -Sum).Sum), 2)
    total_private_memory_mb = [math]::Round((($endTree | Measure-Object -Property private_memory_mb -Sum).Sum), 2)
    process_count = $endTree.Count
    excluded_stale_children = @($endSnapshot.excluded_stale_children)
    automation_verified = $automationVerified
    automation_report = $automationReport
    process_cpu_deltas = $processDeltas
    notes = @(
      "Average CPU percent is total process-tree CPU delta divided by elapsed seconds and logical processor count.",
      "Descendants with creation timestamps before the root are excluded to avoid PID-reuse contamination.",
      "Use longer samples and comparable Electron automation before making final idle CPU claims.",
      "Rows with sampled-with-unverified-automation are CPU samples only, not proof that the expected tab count opened."
    )
  }

  $outputDirectory = Split-Path -Parent $OutputPath
  if ($outputDirectory -and -not (Test-Path -LiteralPath $outputDirectory)) {
    New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
  }
  $result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
  $result | ConvertTo-Json -Depth 10
} finally {
  Stop-StartedProcessTree -Process $startedProcess
}
