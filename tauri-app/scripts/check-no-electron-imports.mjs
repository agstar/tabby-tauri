const DEFAULT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

const PATTERNS = [
  { name: 'electron-import', regex: /from\s+['"]electron['"]|import\s+['"]electron['"]|import\s*\([^)]*['"]electron['"]/ },
  { name: 'electron-require', regex: /require\s*\(\s*['"]electron['"]\s*\)/ },
  { name: 'electron-remote', regex: /@electron\/remote/ },
  { name: 'node-module-loader', regex: /require\s*\(\s*['"]module['"]\s*\)/ },
  { name: 'dynamic-global-require', regex: /global\s*\[\s*['"]require['"]\s*\]/ },
]

export async function scanForElectronImports(root, options = {}) {
  const { readdir, readFile } = await import('node:fs/promises')
  const { extname, join } = await import('node:path')
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS
  const findings = []

  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'target') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
        continue
      }
      if (!extensions.has(extname(entry.name))) continue
      const text = await readFile(path, 'utf8')
      for (const pattern of PATTERNS) {
        if (pattern.regex.test(text)) {
          findings.push({ file: path, pattern: pattern.name })
        }
      }
    }
  }

  await visit(root)
  return findings
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('check-no-electron-imports.mjs')) {
  const root = process.argv[2] ?? new URL('..', import.meta.url).pathname
  const findings = await scanForElectronImports(root)
  if (findings.length) {
    console.error('Electron/Node plugin-loader imports are not allowed in tabby-tauri MVP sources:')
    for (const finding of findings) {
      console.error(`- ${finding.file}: ${finding.pattern}`)
    }
    process.exit(1)
  }
  console.log('No Electron or dynamic Node plugin-loader imports found.')
}
