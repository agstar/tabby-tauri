param(
  [int]$IdleSeconds = 3600,
  [int]$Probes = 3,
  [int]$IntervalMs = 1000,
  [string]$OutputPath = "..\..\.omx\plans\ssh-idle-soak-tabby-tauri-windows.json"
)

$ErrorActionPreference = "Stop"
$exitCodeToReturn = 0

function Redact-SshOutput {
  param([string]$Line)

  $redacted = [string]$Line
  $secretNames = @(
    "TABBY_TAURI_SSH_PASSWORD",
    "TABBY_TAURI_SSH_KEY_PASSPHRASE",
    "TABBY_TAURI_SSH_KEY_PATH",
    "TABBY_TAURI_SSH_PRIVATE_KEY"
  )
  foreach ($name in $secretNames) {
    $secret = [Environment]::GetEnvironmentVariable($name)
    if ($secret) {
      $redacted = $redacted.Replace($secret, "[REDACTED]")
    }
  }
  return ($redacted -replace "(?i)(password|passphrase|private[_-]?key|token|secret)(\s*[=:]\s*)([^\s,;]+)", "`$1`$2[REDACTED]")
}

$required = @(
  "TABBY_TAURI_SSH_HOST",
  "TABBY_TAURI_SSH_USERNAME"
)

$missing = @()
foreach ($name in $required) {
  if (-not [Environment]::GetEnvironmentVariable($name)) {
    $missing += $name
  }
}

if (-not [Environment]::GetEnvironmentVariable("TABBY_TAURI_SSH_PASSWORD") -and
    -not [Environment]::GetEnvironmentVariable("TABBY_TAURI_SSH_KEY_PATH")) {
  $missing += "TABBY_TAURI_SSH_PASSWORD or TABBY_TAURI_SSH_KEY_PATH"
}

$startedAt = (Get-Date).ToUniversalTime()

if ($missing.Count -gt 0) {
  $result = [ordered]@{
    scenario = "ssh-idle-soak"
    status = "skipped-missing-env"
    generated_at = $startedAt.ToString("o")
    idle_seconds = $IdleSeconds
    probes = $Probes
    interval_ms = $IntervalMs
    raw_credentials_persisted = $false
    missing = $missing
    command = "cargo test --test ssh_transport_smoke ssh_transport_idle_soak_uses_real_server_when_env_is_present -- --ignored --nocapture"
    notes = @(
      "Set TABBY_TAURI_SSH_HOST, TABBY_TAURI_SSH_USERNAME, and either TABBY_TAURI_SSH_PASSWORD or TABBY_TAURI_SSH_KEY_PATH.",
      "Optional: TABBY_TAURI_SSH_PORT, TABBY_TAURI_SSH_HOST_KEY, TABBY_TAURI_SSH_KEY_PASSPHRASE.",
      "This script records an explicit skip instead of silently claiming SSH idle coverage."
    )
  }
} else {
  $env:TABBY_TAURI_SSH_IDLE_SECONDS = [string]$IdleSeconds
  $env:TABBY_TAURI_SSH_KEEPALIVE_PROBES = [string]$Probes
  $env:TABBY_TAURI_SSH_KEEPALIVE_INTERVAL_MS = [string]$IntervalMs

  Push-Location src-tauri
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = & cargo test --test ssh_transport_smoke ssh_transport_idle_soak_uses_real_server_when_env_is_present -- --ignored --nocapture 2>&1 |
      ForEach-Object { Redact-SshOutput $_.ToString() }
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    Pop-Location
  }

  $finishedAt = (Get-Date).ToUniversalTime()
  $result = [ordered]@{
    scenario = "ssh-idle-soak"
    status = if ($exitCode -eq 0) { "passed" } else { "failed" }
    generated_at = $finishedAt.ToString("o")
    started_at = $startedAt.ToString("o")
    finished_at = $finishedAt.ToString("o")
    idle_seconds = $IdleSeconds
    probes = $Probes
    interval_ms = $IntervalMs
    raw_credentials_persisted = $false
    command = "cargo test --test ssh_transport_smoke ssh_transport_idle_soak_uses_real_server_when_env_is_present -- --ignored --nocapture"
    exit_code = $exitCode
    output = $output
    notes = @(
      "Uses the Rust russh transport against the configured real SSH server.",
      "Pass means shell open, pre-idle write, idle wait, keepalive evaluator, post-idle write, and close all completed.",
      "Use IdleSeconds=3600 for the PRD one-hour soak."
    )
  }

  $exitCodeToReturn = $exitCode
}

$outputDirectory = Split-Path -Parent $OutputPath
if ($outputDirectory -and -not (Test-Path -LiteralPath $outputDirectory)) {
  New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
}

$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
$result | ConvertTo-Json -Depth 8

if ($exitCodeToReturn -ne 0) {
  exit $exitCodeToReturn
}
