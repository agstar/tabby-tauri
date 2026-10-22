param(
  [string]$TauriResultPath = "..\..\.omx\plans\memory-feasibility-tabby-tauri-windows.json",
  [string]$ElectronResultPath,
  [string]$OutputPath = "..\..\.omx\plans\memory-comparison-tabby-tauri-windows.json"
)

$ErrorActionPreference = "Stop"

function Read-MemoryResult {
  param(
    [string]$Path,
    [string]$Name
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "$Name result does not exist: $Path"
  }
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Get-Delta {
  param(
    [double]$TauriValue,
    [double]$ElectronValue
  )

  [ordered]@{
    absolute_mb = [math]::Round($TauriValue - $ElectronValue, 2)
    percent = if ($ElectronValue -eq 0) { $null } else { [math]::Round((($TauriValue - $ElectronValue) / $ElectronValue) * 100, 2) }
  }
}

function Get-MemorySummary {
  param([object]$Result)

  if ($Result.results) {
    return [ordered]@{
      source_scenario = $Result.scenario
      total_working_set_mb = $null
      total_private_memory_mb = $null
      process_count = $null
      sampled_at_end = $Result.generated_at
      rows = @($Result.results | ForEach-Object {
          [ordered]@{
            tab_count = $_.tab_count
            total_working_set_mb = $_.total_working_set_mb
            total_private_memory_mb = $_.total_private_memory_mb
            process_count = $_.process_count
            automation_verified = $_.automation_verified
          }
        })
    }
  }

  return [ordered]@{
    source_scenario = $Result.scenario
    total_working_set_mb = $Result.total_working_set_mb
    total_private_memory_mb = $Result.total_private_memory_mb
    process_count = $Result.process_count
    sampled_at_end = $Result.sampled_at_end
  }
}

function Test-IntegerValue {
  param([object]$Value)

  $parsed = 0
  return [int]::TryParse([string]$Value, [ref]$parsed)
}

function Get-InvalidMatrixTabCounts {
  param([object[]]$Rows)

  return @(
    $Rows |
      Where-Object { -not (Test-IntegerValue $_.tab_count) } |
      ForEach-Object { [string]$_.tab_count } |
      Sort-Object -Unique
  )
}

function Get-MatrixDeltaRows {
  param(
    [object[]]$TauriRows,
    [object[]]$ElectronRows
  )

  $electronByTabCount = @{}
  foreach ($row in $ElectronRows) {
    $electronByTabCount[[int]$row.tab_count] = $row
  }

  $deltaRows = @()
  foreach ($tauriRow in ($TauriRows | Sort-Object -Property { [int]$_.tab_count })) {
    $tabCount = [int]$tauriRow.tab_count
    if (-not $electronByTabCount.ContainsKey($tabCount)) {
      continue
    }
    $electronRow = $electronByTabCount[$tabCount]
    $deltaRows += [ordered]@{
      tab_count = $tabCount
      working_set = Get-Delta -TauriValue ([double]$tauriRow.total_working_set_mb) -ElectronValue ([double]$electronRow.total_working_set_mb)
      private_memory = Get-Delta -TauriValue ([double]$tauriRow.total_private_memory_mb) -ElectronValue ([double]$electronRow.total_private_memory_mb)
      process_count = [ordered]@{
        absolute = ([int]$tauriRow.process_count) - ([int]$electronRow.process_count)
      }
      tauri_automation_verified = [bool]$tauriRow.automation_verified
      electron_automation_verified = [bool]$electronRow.automation_verified
    }
  }

  return $deltaRows
}

function Get-MatrixTabCounts {
  param([object[]]$Rows)

  return @(
    $Rows |
      Where-Object { Test-IntegerValue $_.tab_count } |
      ForEach-Object { [int]$_.tab_count } |
      Sort-Object
  )
}

function Get-DuplicateMatrixTabCounts {
  param([object[]]$Rows)

  return @(
    $Rows |
      Where-Object { Test-IntegerValue $_.tab_count } |
      ForEach-Object { [int]$_.tab_count } |
      Group-Object |
      Where-Object { $_.Count -gt 1 } |
      ForEach-Object { [int]$_.Name } |
      Sort-Object
  )
}

$tauri = Read-MemoryResult -Path $TauriResultPath -Name "Tauri"
$comparison = [ordered]@{
  scenario = "tauri-vs-electron-process-tree-memory"
  generated_at = (Get-Date).ToUniversalTime().ToString("o")
  tauri_result_path = $TauriResultPath
  electron_result_path = $ElectronResultPath
  tauri = Get-MemorySummary -Result $tauri
  electron = $null
  deltas = $null
  status = "missing-electron-baseline"
  notes = @(
    "Run on the same Windows machine with comparable warmup/sample durations.",
    "Provide -ElectronResultPath after collecting an Electron baseline with the same process-tree schema.",
    "Do not claim Tauri memory success until status is compared."
  )
}

if ($ElectronResultPath) {
  $electron = Read-MemoryResult -Path $ElectronResultPath -Name "Electron"
  $comparison.electron = Get-MemorySummary -Result $electron
  $warnings = @()
  $hasInvalidMatrixRows = $false
  $hasDuplicateMatrixRows = $false
  if ($tauri.results) {
    $invalidTauriRows = @(Get-InvalidMatrixTabCounts -Rows @($tauri.results))
    if ($invalidTauriRows.Count -gt 0) {
      $warnings += "Tauri matrix contains non-numeric tab_count rows: $($invalidTauriRows -join ', ')."
      $hasInvalidMatrixRows = $true
    }
    $duplicateTauriRows = @(Get-DuplicateMatrixTabCounts -Rows @($tauri.results))
    if ($duplicateTauriRows.Count -gt 0) {
      $warnings += "Tauri matrix contains duplicate tab_count rows: $($duplicateTauriRows -join ', ')."
      $hasDuplicateMatrixRows = $true
    }
  }
  if ($electron.results) {
    $invalidElectronRows = @(Get-InvalidMatrixTabCounts -Rows @($electron.results))
    if ($invalidElectronRows.Count -gt 0) {
      $warnings += "Electron matrix contains non-numeric tab_count rows: $($invalidElectronRows -join ', ')."
      $hasInvalidMatrixRows = $true
    }
    $duplicateElectronRows = @(Get-DuplicateMatrixTabCounts -Rows @($electron.results))
    if ($duplicateElectronRows.Count -gt 0) {
      $warnings += "Electron matrix contains duplicate tab_count rows: $($duplicateElectronRows -join ', ')."
      $hasDuplicateMatrixRows = $true
    }
  }

  if (-not $tauri.results -and -not $electron.results) {
    $comparison.deltas = [ordered]@{
      working_set = Get-Delta -TauriValue $tauri.total_working_set_mb -ElectronValue $electron.total_working_set_mb
      private_memory = Get-Delta -TauriValue $tauri.total_private_memory_mb -ElectronValue $electron.total_private_memory_mb
      process_count = [ordered]@{
        absolute = $tauri.process_count - $electron.process_count
      }
    }
  } elseif ($tauri.results -and $electron.results -and -not $hasInvalidMatrixRows -and -not $hasDuplicateMatrixRows) {
    $comparison.deltas = [ordered]@{
      rows = @(Get-MatrixDeltaRows -TauriRows @($tauri.results) -ElectronRows @($electron.results))
    }
  }
  if ($tauri.scenario -ne $electron.scenario) {
    $warnings += "Scenario names differ; treat deltas as smoke evidence until comparable scenarios are collected."
  }
  if (-not $electron.results -and $electron.process_count -le 1) {
    $warnings += "Electron process tree has one or fewer processes; app may not have reached a full renderer-backed steady state."
  }
  if ($tauri.results -and -not $electron.results) {
    $warnings += "Tauri result is a scenario matrix but Electron result is a single scenario; per-tab deltas are intentionally omitted."
  }
  if (-not $tauri.results -and $electron.results) {
    $warnings += "Electron result is a scenario matrix but Tauri result is a single scenario; per-tab deltas are intentionally omitted."
  }
  if ($tauri.results -and $electron.results) {
    $tauriTabCounts = @(Get-MatrixTabCounts -Rows @($tauri.results))
    $electronTabCounts = @(Get-MatrixTabCounts -Rows @($electron.results))
    $missingElectronRows = @($tauriTabCounts | Where-Object { $electronTabCounts -notcontains $_ })
    $missingTauriRows = @($electronTabCounts | Where-Object { $tauriTabCounts -notcontains $_ })
    if ($missingElectronRows.Count -gt 0) {
      $warnings += "Electron matrix is missing tab_count rows present in Tauri matrix: $($missingElectronRows -join ', ')."
    }
    if ($missingTauriRows.Count -gt 0) {
      $warnings += "Tauri matrix is missing tab_count rows present in Electron matrix: $($missingTauriRows -join ', ')."
    }
    if (-not $hasInvalidMatrixRows -and -not $hasDuplicateMatrixRows -and @($comparison.deltas.rows).Count -eq 0) {
      $warnings += "No overlapping tab_count rows were available for per-tab comparison."
    }
  }
  if ($tauri.results -and @($tauri.results | Where-Object { -not $_.automation_verified }).Count -gt 0) {
    $warnings += "At least one Tauri matrix row lacks a verified opened_tabs marker."
  }
  if ($electron.results -and @($electron.results | Where-Object { -not $_.automation_verified }).Count -gt 0) {
    $warnings += "At least one Electron matrix row lacks a verified opened_tabs marker."
  }
  if ($warnings.Count -gt 0) {
    $comparison.status = "compared-with-warnings"
    $comparison.warnings = $warnings
  } else {
    $comparison.status = "compared"
  }
}

$outputDirectory = Split-Path -Parent $OutputPath
if ($outputDirectory -and -not (Test-Path -LiteralPath $outputDirectory)) {
  New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
}

$comparison | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
$comparison | ConvertTo-Json -Depth 8
