param(
  [int]$ProcessId,
  [string]$AppPath,
  [string[]]$AppArguments = @(),
  [int[]]$TabCounts = @(1, 6, 10, 20),
  [string]$ScenarioPrefix = "tauri-tab-count",
  [int]$WarmupSeconds = 20,
  [int]$SampleSeconds = 60,
  [string]$OutputPath = "..\..\.omx\plans\memory-scenario-matrix-tabby-tauri-windows.json",
  [string]$ArgumentTemplate
)

$ErrorActionPreference = "Stop"

function Expand-Arguments {
  param(
    [string[]]$BaseArguments,
    [string]$Template,
    [int]$Count
  )

  $expanded = @()
  foreach ($argument in $BaseArguments) {
    $expanded += $argument.Replace("{count}", [string]$Count)
  }

  if ($Template) {
    $expanded += ($Template.Replace("{count}", [string]$Count) -split " ")
  }

  return $expanded | Where-Object { $_ -ne "" }
}

function Write-Result {
  param([object]$Result)

  $outputDirectory = Split-Path -Parent $OutputPath
  if ($outputDirectory -and -not (Test-Path -LiteralPath $outputDirectory)) {
    New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
  }

  $Result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
  $Result | ConvertTo-Json -Depth 10
}

$startedAt = (Get-Date).ToUniversalTime()

if (-not $ProcessId -and (-not $AppPath -or -not (Test-Path -LiteralPath $AppPath))) {
  Write-Result ([ordered]@{
      scenario = "memory-scenario-matrix"
      status = "skipped-missing-target"
      generated_at = $startedAt.ToString("o")
      root_pid = $ProcessId
      app_path = $AppPath
      requested_tab_counts = $TabCounts
      notes = @(
        "Provide -AppPath to a built Electron/Tauri executable, or -ProcessId for an already launched app whose tabs were opened by another automation path.",
        "Use -ArgumentTemplate or -AppArguments with {count} only when the target app can open a deterministic tab count from CLI.",
        "This skip artifact prevents claiming multi-tab performance coverage without a runnable app."
      )
    })
  exit 0
}

if ($ProcessId -and -not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
  Write-Result ([ordered]@{
      scenario = "memory-scenario-matrix"
      status = "skipped-missing-process"
      generated_at = $startedAt.ToString("o")
      root_pid = $ProcessId
      app_path = $AppPath
      requested_tab_counts = $TabCounts
      notes = @(
        "The supplied -ProcessId was not running when sampled.",
        "Use attached-process mode only after the target app and intended tab count are already prepared.",
        "This skip artifact prevents claiming multi-tab performance coverage for a missing process."
      )
    })
  exit 0
}

$measureScript = Join-Path $PSScriptRoot "measure-process-tree.ps1"
$results = @()

foreach ($count in $TabCounts) {
  $scenario = "$ScenarioPrefix-$count-tabs"
  $samplePath = Join-Path ([IO.Path]::GetTempPath()) "$scenario-$(Get-Random).json"
  $arguments = @(Expand-Arguments -BaseArguments $AppArguments -Template $ArgumentTemplate -Count $count)
  $automationStatus = if ($ProcessId) {
    "attached-process-external-automation-required"
  } elseif ($ArgumentTemplate -or $AppArguments.Count -gt 0) {
    "argument-driven"
  } else {
    "no-tab-automation-arguments"
  }

  try {
    Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Filter "tabby-tauri-perf-automation-*.json" -ErrorAction SilentlyContinue |
      Remove-Item -Force -ErrorAction SilentlyContinue

    if ($ProcessId) {
      & $measureScript `
        -ProcessId $ProcessId `
        -Scenario $scenario `
        -WarmupSeconds $WarmupSeconds `
        -SampleSeconds $SampleSeconds `
        -OutputPath $samplePath | Out-Null
    } else {
      & $measureScript `
        -AppPath $AppPath `
        -AppArguments $arguments `
        -Scenario $scenario `
        -WarmupSeconds $WarmupSeconds `
        -SampleSeconds $SampleSeconds `
        -OutputPath $samplePath | Out-Null
    }

    $sample = Get-Content -LiteralPath $samplePath -Raw | ConvertFrom-Json
    $automationReportPath = Join-Path ([IO.Path]::GetTempPath()) "tabby-tauri-perf-automation-$($sample.root_pid).json"
    $automationReport = $null
    if (Test-Path -LiteralPath $automationReportPath) {
      $automationReport = Get-Content -LiteralPath $automationReportPath -Raw | ConvertFrom-Json
    }
    $automationVerified = $false
    if ($automationReport) {
      $automationVerified = (
        [int]$automationReport.requested_tabs -eq $count -and
        [int]$automationReport.opened_tabs -eq $count -and
        @($automationReport.errors).Count -eq 0
      )
    }
    $results += [ordered]@{
      tab_count = $count
      status = "sampled"
      scenario = $sample.scenario
      root_pid = $sample.root_pid
      app_arguments = $sample.app_arguments
      total_working_set_mb = $sample.total_working_set_mb
      total_private_memory_mb = $sample.total_private_memory_mb
      process_count = $sample.process_count
      sampled_at_end = $sample.sampled_at_end
      automation_status = $automationStatus
      automation_verified = $automationVerified
      automation_report = $automationReport
    }
  } catch {
    $results += [ordered]@{
      tab_count = $count
      status = "failed"
      scenario = $scenario
      error = $_.Exception.Message
      automation_status = $automationStatus
    }
  } finally {
    if (Test-Path -LiteralPath $samplePath) {
      Remove-Item -LiteralPath $samplePath -Force
    }
  }
}

$failed = @($results | Where-Object { $_.status -eq "failed" })
$notAutomated = @($results | Where-Object { $_.automation_status -eq "no-tab-automation-arguments" })
$attached = @($results | Where-Object { $_.automation_status -eq "attached-process-external-automation-required" })

Write-Result ([ordered]@{
    scenario = "memory-scenario-matrix"
    status = if ($failed.Count -gt 0) { "completed-with-failures" } elseif ($attached.Count -gt 0) { "sampled-attached-process" } elseif ($notAutomated.Count -gt 0) { "sampled-without-tab-automation" } else { "sampled" }
    generated_at = (Get-Date).ToUniversalTime().ToString("o")
    root_pid = $ProcessId
    app_path = $AppPath
    warmup_seconds = $WarmupSeconds
    sample_seconds = $SampleSeconds
    requested_tab_counts = $TabCounts
    results = $results
    notes = @(
      "Each row uses the same process-tree schema as measure-process-tree.ps1.",
      "Rows marked no-tab-automation-arguments are process samples only; they are not proof that the requested tab count was opened.",
      "Rows marked attached-process-external-automation-required assume another tool or manual setup opened the requested tabs before sampling.",
      "Use an app-specific CLI/profile automation path before making final 1/6/10/20 tab performance claims."
    )
  })
