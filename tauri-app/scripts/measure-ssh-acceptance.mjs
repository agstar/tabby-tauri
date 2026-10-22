#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..', '..')
const tauriRoot = resolve(__dirname, '..')
const defaultArtifactPath = resolve(repoRoot, '.omx', 'plans', 'ssh-acceptance-smoke-tabby-tauri-windows.json')

const args = new Map()
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index]
  if (!arg.startsWith('--')) {
    continue
  }
  const [key, inlineValue] = arg.slice(2).split('=', 2)
  if (inlineValue !== undefined) {
    args.set(key, inlineValue)
  } else if (process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    args.set(key, process.argv[index + 1])
    index += 1
  } else {
    args.set(key, 'true')
  }
}

const artifactPath = resolve(args.get('out') ?? process.env.TABBY_TAURI_SSH_ACCEPTANCE_ARTIFACT ?? defaultArtifactPath)
const scenario = args.get('scenario') ?? 'ssh-acceptance-smoke'
const generatedAt = new Date().toISOString()

const sensitiveNames = [
  'TABBY_TAURI_SSH_PASSWORD',
  'TABBY_TAURI_SSH_KEY_PASSPHRASE',
  'TABBY_TAURI_SSH_KEY_PATH',
  'TABBY_TAURI_SSH_PRIVATE_KEY',
]
const sensitiveValues = sensitiveNames
  .map(name => process.env[name])
  .filter(value => typeof value === 'string' && value.length > 0)

function redactSecrets (value) {
  let text = String(value ?? '')
  for (const secret of sensitiveValues) {
    text = text.split(secret).join('[REDACTED]')
  }
  return text
    .replace(/(password|passphrase|private[_-]?key|token|secret)(\s*[=:]\s*)([^\s,;]+)/gi, '$1$2[REDACTED]')
    .replace(/(TABBY_TAURI_SSH_(?:PASSWORD|KEY_PASSPHRASE|KEY_PATH|PRIVATE_KEY))=([^\s]+)/g, '$1=[REDACTED]')
}

function redactOutput (output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .map(redactSecrets)
    .filter(Boolean)
    .slice(-120)
}

const required = ['TABBY_TAURI_SSH_HOST', 'TABBY_TAURI_SSH_USERNAME']
const missing = required.filter(name => !process.env[name])
if (!process.env.TABBY_TAURI_SSH_PASSWORD && !process.env.TABBY_TAURI_SSH_KEY_PATH) {
  missing.push('TABBY_TAURI_SSH_PASSWORD or TABBY_TAURI_SSH_KEY_PATH')
}

let command = null
let exitCode = 0
let status = 'skipped-missing-env'
let output = []

if (missing.length === 0) {
  command = [
    'cargo',
    'test',
    '--test',
    'ssh_transport_smoke',
    'ssh_transport_smoke_uses_real_server_when_env_is_present',
    '--',
    '--nocapture',
  ]
  const result = spawnSync(command[0], command.slice(1), {
    cwd: resolve(tauriRoot, 'src-tauri'),
    encoding: 'utf8',
    env: process.env,
  })
  exitCode = result.status ?? 1
  status = exitCode === 0 ? 'passed' : 'failed'
  output = redactOutput(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
} else {
  output = [
    'Set TABBY_TAURI_SSH_HOST, TABBY_TAURI_SSH_USERNAME, and either TABBY_TAURI_SSH_PASSWORD or TABBY_TAURI_SSH_KEY_PATH to run real SSH smoke acceptance.',
    'This harness writes an explicit skipped artifact instead of claiming remote SSH coverage.',
  ]
}

const artifact = {
  scenario,
  status,
  generated_at: generatedAt,
  target: {
    host_present: Boolean(process.env.TABBY_TAURI_SSH_HOST),
    port: process.env.TABBY_TAURI_SSH_PORT ? Number(process.env.TABBY_TAURI_SSH_PORT) : 22,
    username_present: Boolean(process.env.TABBY_TAURI_SSH_USERNAME),
  },
  credential_values_redacted: true,
  raw_credentials_persisted: false,
  credential_inputs: {
    password_present: Boolean(process.env.TABBY_TAURI_SSH_PASSWORD),
    key_path_present: Boolean(process.env.TABBY_TAURI_SSH_KEY_PATH),
    key_passphrase_present: Boolean(process.env.TABBY_TAURI_SSH_KEY_PASSPHRASE),
  },
  coverage: [
    'first-connect-host-key-scan',
    'trusted-host-reconnect',
    'password-or-private-key-auth',
    'shell-write-read-close',
    'sanitized-output-artifact',
  ],
  missing,
  command: command ? command.join(' ') : null,
  exit_code: exitCode,
  output,
}

mkdirSync(dirname(artifactPath), { recursive: true })
writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ artifact: artifactPath, status, raw_credentials_persisted: false }, null, 2))

if (exitCode !== 0) {
  process.exit(exitCode)
}
