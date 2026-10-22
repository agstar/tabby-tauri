param(
  [int]$ProcessId,
  [string]$AppPath,
  [int]$WarmupSeconds = 20,
  [int]$SampleSeconds = 60,
  [string]$OutputPath = "..\..\.omx\plans\memory-feasibility-tabby-tauri-windows.json"
)

$ErrorActionPreference = "Stop"

function Get-ProcessTree {
  param([int]$RootProcessId)

  $allProcesses = Get-CimInstance Win32_Process
  $byParent = @{}
  foreach ($proc in $allProcesses) {
    $parent = [int]$proc.ParentProcessId
    if (-not $byParent.ContainsKey($parent)) {
      $byParent[$parent] = New-Object System.Collections.Generic.List[object]
    }
    $byParent[$parent].Add($proc)
  }

  $queue = New-Object System.Collections.Generic.Queue[int]
  $visited = New-Object System.Collections.Generic.HashSet[int]
  $queue.Enqueue($RootProcessId)
  [void]$visited.Add($RootProcessId)
  $tree = @()

  while ($queue.Count -gt 0) {
    $id = $queue.Dequeue()
    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($proc) {
      $tree += [pscustomobject][ordered]@{
        pid = $proc.Id
        name = $proc.ProcessName
        working_set_mb = [math]::Round($proc.WorkingSet64 / 1MB, 2)
        private_memory_mb = [math]::Round($proc.PrivateMemorySize64 / 1MB, 2)
        cpu_seconds = if ($null -eq $proc.CPU) { 0 } else { [math]::Round($proc.CPU, 2) }
      }
    }

    if ($byParent.ContainsKey($id)) {
      foreach ($child in $byParent[$id]) {
        $childId = [int]$child.ProcessId
        if ($visited.Add($childId)) {
          $queue.Enqueue($childId)
        }
      }
    }
  }

  return $tree
}

if (-not $ProcessId -and -not $AppPath) {
  throw "Provide either -ProcessId for an already launched Tauri shell or -AppPath for a built executable."
}

$startedProcess = $null
if ($AppPath) {
  if (-not (Test-Path -LiteralPath $AppPath)) {
    throw "AppPath does not exist: $AppPath"
  }
  $startedProcess = Start-Process -FilePath $AppPath -PassThru
  $ProcessId = $startedProcess.Id
}

try {
  Start-Sleep -Seconds $WarmupSeconds
  $before = Get-Date
  $first = Get-ProcessTree -RootProcessId $ProcessId
  Start-Sleep -Seconds $SampleSeconds
  $after = Get-Date
  $second = Get-ProcessTree -RootProcessId $ProcessId

  $result = [ordered]@{
    scenario = "minimal-webview2-curated-shell"
    root_pid = $ProcessId
    app_path = $AppPath
    warmup_seconds = $WarmupSeconds
    sample_seconds = $SampleSeconds
    sampled_at_start = $before.ToUniversalTime().ToString("o")
    sampled_at_end = $after.ToUniversalTime().ToString("o")
    process_tree = $second
    total_working_set_mb = [math]::Round((($second | Measure-Object -Property working_set_mb -Sum).Sum), 2)
    total_private_memory_mb = [math]::Round((($second | Measure-Object -Property private_memory_mb -Sum).Sum), 2)
    process_count = $second.Count
    notes = @(
      "Includes the Tauri executable and descendant WebView2 processes.",
      "Run before enabling local PTY or SSH backends.",
      "Compare against Electron baseline on the same Windows machine before making performance claims."
    )
  }

  $resolvedOutput = Resolve-Path -LiteralPath (Split-Path -Parent $OutputPath) -ErrorAction SilentlyContinue
  if (-not $resolvedOutput) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
  }
  $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
  $result | ConvertTo-Json -Depth 8
} finally {
  if ($startedProcess -and -not $startedProcess.HasExited) {
    Stop-Process -Id $startedProcess.Id -Force
  }
}
