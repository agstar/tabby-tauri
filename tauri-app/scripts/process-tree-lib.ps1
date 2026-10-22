function ConvertTo-UtcDateTime {
  param([object]$Value)

  if ($null -eq $Value) {
    return $null
  }
  if ($Value -is [datetime]) {
    return $Value.ToUniversalTime()
  }

  try {
    return ([Management.ManagementDateTimeConverter]::ToDateTime([string]$Value)).ToUniversalTime()
  } catch {
    try {
      return ([datetime]::Parse([string]$Value)).ToUniversalTime()
    } catch {
      return $null
    }
  }
}

function Get-ProcessTreeProcessIds {
  param(
    [int]$RootProcessId,
    [object[]]$AllProcesses
  )

  $rootInfo = @($AllProcesses | Where-Object { [int]$_.ProcessId -eq $RootProcessId } | Select-Object -First 1)
  $rootStartedAtUtc = if ($rootInfo.Count -gt 0) { ConvertTo-UtcDateTime $rootInfo[0].CreationDate } else { $null }

  $byParent = @{}
  foreach ($proc in $AllProcesses) {
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
  $processIds = @()
  $excludedStaleChildren = @()

  while ($queue.Count -gt 0) {
    $id = $queue.Dequeue()
    $processIds += $id

    if (-not $byParent.ContainsKey($id)) {
      continue
    }

    foreach ($child in $byParent[$id]) {
      $childId = [int]$child.ProcessId
      if ($visited.Contains($childId)) {
        continue
      }

      $childStartedAtUtc = ConvertTo-UtcDateTime $child.CreationDate
      if ($rootStartedAtUtc -and $childStartedAtUtc -and $childStartedAtUtc -lt $rootStartedAtUtc) {
        $excludedStaleChildren += [pscustomobject][ordered]@{
          pid = $childId
          parent_pid = $id
          name = $child.Name
          creation_utc = $childStartedAtUtc.ToString("o")
          reason = "child-started-before-root"
        }
        [void]$visited.Add($childId)
        continue
      }

      if ($visited.Add($childId)) {
        $queue.Enqueue($childId)
      }
    }
  }

  return [pscustomobject][ordered]@{
    process_ids = $processIds
    root_started_at_utc = if ($rootStartedAtUtc) { $rootStartedAtUtc.ToString("o") } else { $null }
    excluded_stale_children = $excludedStaleChildren
  }
}

function Get-ProcessTreeSnapshot {
  param(
    [int]$RootProcessId,
    [switch]$RoundCpu
  )

  $allProcesses = @(Get-CimInstance Win32_Process)
  $treeIds = Get-ProcessTreeProcessIds -RootProcessId $RootProcessId -AllProcesses $allProcesses
  $tree = @()

  foreach ($id in $treeIds.process_ids) {
    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($proc) {
      $cpuSeconds = if ($null -eq $proc.CPU) { 0.0 } else { [double]$proc.CPU }
      $tree += [pscustomobject][ordered]@{
        pid = $proc.Id
        name = $proc.ProcessName
        cpu_seconds = if ($RoundCpu) { [math]::Round($cpuSeconds, 2) } else { $cpuSeconds }
        working_set_mb = [math]::Round($proc.WorkingSet64 / 1MB, 2)
        private_memory_mb = [math]::Round($proc.PrivateMemorySize64 / 1MB, 2)
      }
    }
  }

  return [pscustomobject][ordered]@{
    tree = $tree
    root_started_at_utc = $treeIds.root_started_at_utc
    excluded_stale_children = $treeIds.excluded_stale_children
  }
}

function Stop-StartedProcessTree {
  param([System.Diagnostics.Process]$Process)

  if ($Process) {
    try {
      & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
    } catch {
      # Best-effort cleanup only. The launched root may already have exited,
      # but attempting taskkill still gives Windows a chance to reap descendants
      # that remain attached to the original process tree.
    }
  }
}
