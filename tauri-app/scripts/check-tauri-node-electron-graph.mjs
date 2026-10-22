import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, '..', '..')
const DEFAULT_ENTRY = 'app/src/entry.tauri.ts'
const DEFAULT_MATRIX = 'docs/tauri/migration/tauri-node-electron-migration-matrix.md'
const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

const PACKAGE_ALIASES = new Map([
  ['tabby-core', 'tabby-core/src'],
  ['tabby-settings', 'tabby-settings/src'],
  ['tabby-terminal', 'tabby-terminal/src'],
  ['tabby-local', 'tabby-local/src'],
  ['tabby-ssh', 'tabby-ssh/src'],
  ['tabby-tauri', 'tabby-tauri/src'],
])

const EXACT_ALIASES = new Map([
  ['russh', 'app/src/tauri-guards/russh.ts'],
  ['@luminati-io/socksv5', 'app/src/tauri-guards/socksv5.ts'],
  ['fs/promises', 'app/src/tauri-providers/fs-promises.ts'],
])

const FORBIDDEN_IMPORTS = new Map([
  ['electron-import', new Set(['electron'])],
  ['electron-remote', new Set(['@electron/remote'])],
  ['node-module-loader', new Set(['module', 'node:module'])],
  ['node-child-process', new Set(['child_process', 'node:child_process', 'mz/child_process'])],
  ['node-crypto', new Set(['crypto', 'node:crypto'])],
  ['node-fs', new Set(['fs', 'fs/promises', 'node:fs', 'node:fs/promises', 'mz/fs'])],
  ['node-net', new Set(['net', 'node:net'])],
  ['node-stream', new Set(['stream', 'node:stream'])],
  ['node-readline', new Set(['readline', 'node:readline'])],
  ['node-http', new Set(['http', 'node:http'])],
  ['node-https', new Set(['https', 'node:https'])],
  ['node-tls', new Set(['tls', 'node:tls'])],
  ['node-os', new Set(['os', 'node:os'])],
  ['node-path', new Set(['path', 'node:path'])],
  ['node-util', new Set(['util', 'node:util'])],
  ['node-constants', new Set(['constants', 'node:constants'])],
  ['node-tempfile', new Set(['tmp', 'tmp-promise'])],
  ['socksv5', new Set(['@luminati-io/socksv5'])],
  ['direct-russh', new Set(['russh'])],
])

const CODE_PATTERNS = [
  { pattern: 'dynamic-global-require', regex: /global\s*\[\s*['"]require['"]\s*\]/ },
  { pattern: 'module-prototype-require', regex: /\b(?:nodeModule|Module)\.prototype\.require\b/ },
]

const TRANSITIONAL_ALLOWLIST = [
  'app/webpack.config.tauri.mjs',
  'tauri-app/tests/',
  'tauri-app/scripts/',
]

function toRepoPath (repoRoot, path) {
  return relative(repoRoot, path).replaceAll(sep, '/')
}

function normalizeRepoPath (path) {
  return normalize(path).replaceAll(sep, '/')
}

function isSourceFile (path) {
  return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extname(path))
}

function isAllowlistedTransitionalFile (repoPath) {
  return TRANSITIONAL_ALLOWLIST.some(prefix => repoPath === prefix || repoPath.startsWith(prefix))
}

function tryResolveFile (candidate) {
  for (const extension of SOURCE_EXTENSIONS) {
    const path = extension ? `${candidate}${extension}` : candidate
    if (existsSync(path) && isSourceFile(path)) {
      return path
    }
  }
  for (const extension of SOURCE_EXTENSIONS.filter(Boolean)) {
    const path = join(candidate, `index${extension}`)
    if (existsSync(path) && isSourceFile(path)) {
      return path
    }
  }
  return null
}

function resolveSpecifier (specifier, importer, repoRoot) {
  if (/^(?:@angular|rxjs|zone\.js|core-js|ngx-|@ng-bootstrap|@fortawesome|ansi-|strip-ansi|shell-quote|hexer|buffer-replace|binstring|lodash|deep-equal|yaml|js-yaml|xterm|@xterm|@tauri-apps)\b/.test(specifier)) {
    return null
  }
  if (specifier.endsWith('.scss') || specifier.endsWith('.css') || specifier.endsWith('.pug') || specifier.endsWith('.svg')) {
    return null
  }
  if (specifier.startsWith('.')) {
    return tryResolveFile(resolve(dirname(importer), specifier))
  }
  const exact = EXACT_ALIASES.get(specifier)
  if (exact) {
    return tryResolveFile(resolve(repoRoot, exact))
  }
  for (const [alias, target] of PACKAGE_ALIASES) {
    if (specifier === alias) {
      return tryResolveFile(resolve(repoRoot, target))
    }
    if (specifier.startsWith(`${alias}/`)) {
      return tryResolveFile(resolve(repoRoot, target, specifier.slice(alias.length + 1)))
    }
  }
  return null
}

function extractDependencies (source) {
  const dependencies = []
  const importExportRegex = /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g
  const dynamicImportRegex = /\bimport\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)?['"]([^'"]+)['"]\s*\)/g
  const requireRegex = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const regex of [importExportRegex, dynamicImportRegex, requireRegex]) {
    for (const match of source.matchAll(regex)) {
      dependencies.push(match[1])
    }
  }
  return dependencies
}

function lineForOffset (source, offset) {
  return source.slice(0, offset).split(/\r?\n/).length
}

function scanForbiddenPatterns (source, file, repoRoot) {
  const findings = []
  const repoPath = toRepoPath(repoRoot, file)
  if (isAllowlistedTransitionalFile(repoPath)) {
    return findings
  }

  for (const specifier of extractDependencies(source)) {
    for (const [pattern, specifiers] of FORBIDDEN_IMPORTS) {
      if (specifiers.has(specifier)) {
        const index = source.indexOf(specifier)
        findings.push({
          file: repoPath,
          pattern,
          specifier,
          line: lineForOffset(source, index),
        })
      }
    }
  }
  for (const { pattern, regex } of CODE_PATTERNS) {
    const match = regex.exec(source)
    if (match) {
      findings.push({
        file: repoPath,
        pattern,
        specifier: null,
        line: lineForOffset(source, match.index),
      })
    }
    regex.lastIndex = 0
  }
  return findings
}

export function buildTauriImportGraph (options = {}) {
  const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT)
  const entry = resolve(repoRoot, options.entry ?? DEFAULT_ENTRY)
  const visited = new Set()
  const edges = new Map()
  const findings = []
  const unresolved = []
  const queue = [entry]

  while (queue.length) {
    const file = queue.shift()
    if (!file || visited.has(file)) continue
    visited.add(file)
    if (!existsSync(file)) {
      unresolved.push({ importer: null, specifier: file })
      continue
    }
    const source = readFileSync(file, 'utf8')
    findings.push(...scanForbiddenPatterns(source, file, repoRoot))
    const children = []
    for (const specifier of extractDependencies(source)) {
      const resolved = resolveSpecifier(specifier, file, repoRoot)
      if (resolved) {
        children.push(resolved)
        if (!visited.has(resolved)) {
          queue.push(resolved)
        }
      }
    }
    edges.set(toRepoPath(repoRoot, file), children.map(child => toRepoPath(repoRoot, child)))
  }

  return {
    entry: toRepoPath(repoRoot, entry),
    files: [...visited].map(file => toRepoPath(repoRoot, file)).sort(),
    edges,
    findings: findings.sort((a, b) => `${a.file}:${a.pattern}`.localeCompare(`${b.file}:${b.pattern}`)),
    unresolved,
  }
}

export function loadMigrationMatrix (options = {}) {
  const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT)
  const matrixPath = resolve(repoRoot, options.matrix ?? DEFAULT_MATRIX)
  if (!existsSync(matrixPath)) {
    return { path: toRepoPath(repoRoot, matrixPath), allowed: new Set(), rows: [] }
  }
  const text = readFileSync(matrixPath, 'utf8')
  const rows = []
  const rowRegex = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/gm
  for (const match of text.matchAll(rowRegex)) {
    const pattern = match[1].trim()
    const file = normalizeRepoPath(match[2].trim())
    rows.push({ pattern, file })
  }
  return {
    path: toRepoPath(repoRoot, matrixPath),
    allowed: new Set(rows.map(row => `${row.file}|${row.pattern}`)),
    rows,
  }
}

export function scanTauriNodeElectronGraph (options = {}) {
  const graph = buildTauriImportGraph(options)
  const matrix = loadMigrationMatrix(options)
  const untracked = graph.findings.filter(finding => !matrix.allowed.has(`${finding.file}|${finding.pattern}`))
  const tracked = graph.findings.filter(finding => matrix.allowed.has(`${finding.file}|${finding.pattern}`))
  return { graph, matrix, tracked, untracked }
}

function printFinding (finding) {
  const specifier = finding.specifier ? ` (${finding.specifier})` : ''
  return `${finding.file}:${finding.line}: ${finding.pattern}${specifier}`
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('check-tauri-node-electron-graph.mjs')) {
  const repoRootArg = process.argv.find(arg => arg.startsWith('--repo-root='))?.slice('--repo-root='.length)
  const json = process.argv.includes('--json')
  const result = scanTauriNodeElectronGraph({ repoRoot: repoRootArg ? resolve(repoRootArg) : DEFAULT_REPO_ROOT })
  if (json) {
    console.log(JSON.stringify({
      entry: result.graph.entry,
      files: result.graph.files,
      findings: result.graph.findings,
      tracked: result.tracked,
      untracked: result.untracked,
      matrix: result.matrix.path,
    }, null, 2))
  }
  if (result.untracked.length) {
    if (!json) {
      console.error('Untracked Node/Electron APIs are reachable from the Tauri renderer graph:')
      for (const finding of result.untracked) {
        console.error(`- ${printFinding(finding)}`)
      }
      console.error(`Add an intentional migration row to ${result.matrix.path}, or remove the reachable import.`)
    }
    process.exit(1)
  }
  if (!json) {
    console.log(`Tauri graph guard OK: ${result.graph.files.length} files scanned, ${result.tracked.length} tracked Node/Electron migration finding(s), 0 untracked.`)
  }
}
