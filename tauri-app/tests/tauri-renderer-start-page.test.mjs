import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'
import test from 'node:test'
import ts from 'typescript'

const repoRoot = resolve(import.meta.dirname, '..', '..')

function includesLoader (use, loaderName) {
  const entries = Array.isArray(use) ? use : [use]
  return entries.some(entry => {
    if (typeof entry === 'string') {
      return entry.includes(loaderName)
    }
    return typeof entry?.loader === 'string' && entry.loader.includes(loaderName)
  })
}

function parseIcoEntries (ico) {
  const count = ico.readUInt16LE(4)
  const entries = []
  for (let index = 0; index < count; index++) {
    const offset = 6 + index * 16
    entries.push({
      width: ico.readUInt8(offset) || 256,
      height: ico.readUInt8(offset + 1) || 256,
      bitCount: ico.readUInt16LE(offset + 6),
      size: ico.readUInt32LE(offset + 8),
      imageOffset: ico.readUInt32LE(offset + 12),
    })
  }
  return entries
}

function unfilterPngScanlines (data, width, height, bytesPerPixel) {
  const stride = width * bytesPerPixel
  const output = Buffer.alloc(stride * height)
  let inputOffset = 0

  for (let y = 0; y < height; y++) {
    const filter = data[inputOffset++]
    const rowOffset = y * stride
    const previousRowOffset = rowOffset - stride

    for (let x = 0; x < stride; x++) {
      const raw = data[inputOffset++]
      const left = x >= bytesPerPixel ? output[rowOffset + x - bytesPerPixel] : 0
      const up = y > 0 ? output[previousRowOffset + x] : 0
      const upLeft = y > 0 && x >= bytesPerPixel ? output[previousRowOffset + x - bytesPerPixel] : 0
      const paeth = (() => {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        if (pa <= pb && pa <= pc) {
          return left
        }
        return pb <= pc ? up : upLeft
      })()
      const reconstructed = {
        0: raw,
        1: raw + left,
        2: raw + up,
        3: raw + Math.floor((left + up) / 2),
        4: raw + paeth,
      }[filter]
      output[rowOffset + x] = reconstructed & 0xff
    }
  }
  return output
}

function parseRgbaPng (png) {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'expected a PNG signature')

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []

  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString('ascii')
    const data = png.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data.readUInt8(8)
      colorType = data.readUInt8(9)
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
  }

  assert.equal(bitDepth, 8, 'taskbar icon PNG should be 8-bit')
  assert.equal(colorType, 6, 'taskbar icon PNG should be RGBA')
  return {
    width,
    height,
    pixels: unfilterPngScanlines(inflateSync(Buffer.concat(idat)), width, height, 4),
  }
}

function brightPixelBounds (png) {
  const { width, height, pixels } = parseRgbaPng(png)
  let left = width
  let top = height
  let right = -1
  let bottom = -1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      const r = pixels[offset]
      const g = pixels[offset + 1]
      const b = pixels[offset + 2]
      const a = pixels[offset + 3]
      if (a > 128 && (r + g + b) / 3 > 80) {
        left = Math.min(left, x)
        top = Math.min(top, y)
        right = Math.max(right, x + 1)
        bottom = Math.max(bottom, y + 1)
      }
    }
  }

  return { width: right - left, height: bottom - top }
}

test('Tauri renderer inlines SVG icons required by TS and Pug templates', async () => {
  const configModule = await import(pathToFileURL(resolve(repoRoot, 'app', 'webpack.config.tauri.mjs')).href)
  const config = configModule.default()
  const rules = config.module.rules

  const inlineSvgRule = rules.find(rule => rule.test?.test('profiles.svg') && includesLoader(rule.use, 'svg-inline-loader'))
  assert.ok(inlineSvgRule, 'expected an svg-inline-loader rule for command/start-page icons')

  const issuer = inlineSvgRule.issuer?.toString?.() ?? JSON.stringify(inlineSvgRule.issuer)
  assert.match(issuer, /ts|js|pug/, 'SVG inline rule must cover TS command providers and Pug template require() calls')

  const genericSvgAssetRule = rules.find(rule => rule.type === 'asset' && rule.test?.test('logo.svg'))
  assert.ok(genericSvgAssetRule, 'expected a generic SVG asset rule for CSS/background assets')
  assert.ok(genericSvgAssetRule.issuer?.not, 'generic SVG asset rule must not also process TS/Pug icon imports')
})

test('Tauri renderer no longer routes Node/Electron APIs through a tauri-shims namespace', () => {
  const webpackConfig = readFileSync(resolve(repoRoot, 'app', 'webpack.config.tauri.mjs'), 'utf8')
  const shimDir = resolve(repoRoot, 'app', 'src', 'tauri-shims')

  assert.doesNotMatch(webpackConfig, /tauri-shims/, 'Tauri webpack aliases/fallbacks must point at providers, guards, or browser polyfills, not tauri-shims')
  assert.equal(existsSync(shimDir), false, 'the legacy tauri-shims source directory must be removed once paths are migrated')
})

test('Tauri messageformat compiler interpolates translate params', () => {
  const compilerProviderPath = resolve(repoRoot, 'app', 'src', 'tauri-providers', 'translate-messageformat-compiler.ts')
  const source = readFileSync(compilerProviderPath, 'utf8')
  const outputText = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText

  const exports = {}
  const module = { exports }
  const require = specifier => {
    if (specifier === '@angular/core') {
      return { InjectionToken: class InjectionToken { constructor (description) { this.description = description } } }
    }
    throw new Error(`Unexpected require in compiler provider test: ${specifier}`)
  }

  Function('exports', 'module', 'require', outputText)(exports, module, require)

  const compiler = new module.exports.TranslateMessageFormatCompiler()
  const compiled = compiler.compile('Version: {version}', 'zh-CN')

  assert.equal(typeof compiled, 'function')
  assert.equal(compiled({ version: '1.2.3' }), 'Version: 1.2.3')
  assert.equal(compiled({}), 'Version: {version}')
})

test('Tauri renderer loads shared logo styles for the start page', () => {
  const entryPath = resolve(repoRoot, 'app', 'src', 'entry.tauri.ts')
  const entry = readFileSync(entryPath, 'utf8')

  assert.match(entry, /import\s+['"]\.\/preload\.scss['"]/, 'start page should reuse Tabby preload logo CSS')
})

test('Tauri generated index paints a dark preload shell before the bundle loads', () => {
  const webpackConfig = readFileSync(resolve(repoRoot, 'app', 'webpack.config.tauri.mjs'), 'utf8')

  assert.match(webpackConfig, /html,\s*body[\s\S]*background:\s*#000e17/, 'initial HTML must set a dark background before JS and CSS loaders run')
  assert.match(webpackConfig, /app-root[\s\S]*background:\s*#1D272D/, 'app-root must also be dark for the first WebView paint')
  assert.match(webpackConfig, /<app-root>[\s\S]*<div class="preload-logo">[\s\S]*Tabby Tauri/, 'Tauri index must include the preload shell inside app-root before Angular bootstraps')
  assert.match(webpackConfig, /<script src="bundle\.tauri\.js"><\/script>/, 'the preload shell must be emitted before the renderer bundle starts executing')
})

test('Tauri renderer overrides the start page logo with its own brand asset', () => {
  const entry = readFileSync(resolve(repoRoot, 'app', 'src', 'entry.tauri.ts'), 'utf8')
  const tauriBrandingScss = readFileSync(resolve(repoRoot, 'app', 'src', 'tauri-branding.scss'), 'utf8')
  const logo = readFileSync(resolve(repoRoot, 'app', 'assets', 'tauri-logo.svg'), 'utf8')
  const appIcon = readFileSync(resolve(repoRoot, 'tauri-app', 'src-tauri', 'icons', 'app-icon.svg'), 'utf8')

  assert.match(entry, /import\s+['"]\.\/tauri-branding\.scss['"]/, 'Tauri entry must load its own branding override after shared preload styles')
  assert.match(
    tauriBrandingScss,
    /\.tabby-logo[\s\S]*url\(['"]\.\.\/assets\/tauri-logo\.svg['"]\)/,
    'Tauri start page should use the Tauri/Rust logo asset instead of the upstream Tabby logo',
  )
  assert.match(tauriBrandingScss, /!important/, 'Tauri branding must override the shared upstream .tabby-logo background')
  assert.match(logo, /id="rust"|stop-color="#ff6f48"|#ff835d/, 'Tauri logo should include the Rust accent from the app icon design')
  assert.equal(
    logo.trim(),
    appIcon.trim(),
    'Tauri start-page logo and Windows/taskbar source SVG should stay visually synchronized',
  )
})

test('Tauri start page title uses the project name under the logo', () => {
  const startPage = readFileSync(resolve(repoRoot, 'tabby-core', 'src', 'components', 'startPage.component.pug'), 'utf8')

  assert.match(startPage, /h1\.tabby-title Tabby Tauri/)
  assert.doesNotMatch(startPage, /h1\.tabby-title Tabby\s*\n\s*sup α/)
})

test('Tauri bundle declares a real multi-size Windows taskbar icon', () => {
  const tauriRoot = resolve(repoRoot, 'tauri-app', 'src-tauri')
  const config = JSON.parse(readFileSync(resolve(tauriRoot, 'tauri.conf.json'), 'utf8'))
  const icons = config.bundle?.icon ?? []

  assert.ok(icons.includes('icons/icon.ico'), 'Tauri bundle must reference the Windows .ico file')
  assert.ok(icons.includes('icons/32x32.png'), 'Tauri bundle must include a small PNG icon for shell surfaces')
  assert.ok(icons.includes('icons/128x128.png'), 'Tauri bundle must include a standard app icon PNG')

  const icoPath = resolve(tauriRoot, 'icons', 'icon.ico')
  const ico = readFileSync(icoPath)
  assert.ok(statSync(icoPath).size > 4096, 'Windows icon must not be the 1x1 placeholder')
  assert.equal(ico.readUInt16LE(0), 0, 'ICO reserved header must be zero')
  assert.equal(ico.readUInt16LE(2), 1, 'ICO type must be icon')
  assert.ok(ico.readUInt16LE(4) >= 4, 'ICO must contain multiple sizes for taskbar/explorer scaling')

  const entries = parseIcoEntries(ico)
  assert.deepEqual(
    entries.map(entry => entry.width),
    [16, 24, 32, 48, 64, 128, 256],
    'Windows icon must include explicit 24/32/48 px taskbar sizes instead of relying on scaled-down large PNGs',
  )
  assert.ok(entries.every(entry => entry.bitCount === 32), 'ICO entries must preserve alpha for Windows shell rendering')
  assert.ok(entries.every(entry => ico.subarray(entry.imageOffset, entry.imageOffset + 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))), 'ICO entries should be PNG-compressed RGBA images')

  const icon32Bounds = brightPixelBounds(readFileSync(resolve(tauriRoot, 'icons', '32x32.png')))
  assert.ok(icon32Bounds.width >= 24, `32px taskbar icon should have a full-size bright mark, got width ${icon32Bounds.width}`)
  assert.ok(icon32Bounds.height >= 20, `32px taskbar icon should have a full-size bright mark, got height ${icon32Bounds.height}`)
})

test('Tauri production renderer trims debug build output while keeping dev builds readable', async () => {
  const configModule = await import(pathToFileURL(resolve(repoRoot, 'app', 'webpack.config.tauri.mjs')).href)
  const previousDevFlag = process.env.TABBY_DEV

  try {
    delete process.env.TABBY_DEV
    const productionConfig = configModule.default()

    process.env.TABBY_DEV = '1'
    const developmentConfig = configModule.default()

    assert.equal(productionConfig.mode, 'production')
    assert.equal(productionConfig.optimization.minimize, true)
    assert.equal(productionConfig.optimization.concatenateModules, true)
    assert.equal(productionConfig.devtool, false)
    assert.equal(productionConfig.output.pathinfo, false)
    assert.equal(productionConfig.output.clean, true)
    assert.equal(productionConfig.output.chunkFilename, '[name].js')

    assert.equal(developmentConfig.mode, 'development')
    assert.equal(developmentConfig.optimization.minimize, false)
    assert.equal(developmentConfig.optimization.concatenateModules, false)
    assert.equal(developmentConfig.devtool, 'source-map')
    assert.equal(developmentConfig.output.pathinfo, true)
    assert.equal(developmentConfig.output.clean, false)
    assert.equal(developmentConfig.output.chunkFilename, '[name].js')
  } finally {
    if (previousDevFlag === undefined) {
      delete process.env.TABBY_DEV
    } else {
      process.env.TABBY_DEV = previousDevFlag
    }
  }
})

test('Tauri bootstrap code-splits bundled plugins before Angular starts', () => {
  const entry = readFileSync(resolve(repoRoot, 'app', 'src', 'entry.tauri.ts'), 'utf8')
  const tsconfig = JSON.parse(readFileSync(resolve(repoRoot, 'tsconfig.tauri.json'), 'utf8'))

  assert.match(entry, /async function loadBundledPluginModules \(\)/, 'Tauri entry must have an async bundled-plugin loader')
  assert.match(
    String(tsconfig.compilerOptions?.module ?? ''),
    /^es20(?:2[0-9]|[3-9][0-9])$|^esnext$/,
    'Tauri TypeScript module target must preserve dynamic imports for webpack chunking',
  )
  for (const [chunk, specifier] of [
    ['tabby-core', 'tabby-core'],
    ['tabby-settings', 'tabby-settings'],
    ['tabby-terminal', 'tabby-terminal'],
    ['tabby-local', 'tabby-local'],
    ['tabby-ssh', 'tabby-ssh'],
    ['tabby-tauri', 'tabby-tauri'],
  ]) {
    assert.match(
      entry,
      new RegExp(`import\\(\\/\\* webpackChunkName: "${chunk}" \\*\\/ '${specifier}'\\)`),
      `${specifier} should be loaded as a named async chunk instead of being folded into the entry bundle`,
    )
  }
  assert.doesNotMatch(entry, /import\s+TabbyCoreModule[\s\S]+from\s+['"]tabby-core['"]/)
  assert.doesNotMatch(entry, /import\s+TabbySettingsModule\s+from\s+['"]tabby-settings['"]/)
  assert.doesNotMatch(entry, /import\s+TabbyLocalModule[\s\S]+from\s+['"]tabby-local['"]/)
  assert.doesNotMatch(entry, /import\s+TabbySSHModule\s+from\s+['"]tabby-ssh['"]/)
  assert.doesNotMatch(entry, /import\s+TauriHostModule\s+from\s+['"]tabby-tauri['"]/)
  assert.match(entry, /provide: bundled\.BOOTSTRAP_DATA/, 'Tauri bootstrap should use the token from the async core plugin module')
  assert.match(entry, /moduleRef\.injector\.get\(bundled\.ConfigService\)/, 'ConfigService should resolve from the async core plugin module')
  assert.match(entry, /moduleRef\.injector\.get\(bundled\.AppService\)/, 'AppService should resolve from the async core plugin module')
  assert.match(entry, /moduleRef\.injector\.get\(bundled\.TerminalService\)/, 'automation tabs should resolve TerminalService from the async local plugin module')
})

test('Tauri terminal scrollback safety keeps existing terminal defaults intact', () => {
  const entry = readFileSync(resolve(repoRoot, 'app', 'src', 'entry.tauri.ts'), 'utf8')
  const tauriSource = readFileSync(resolve(repoRoot, 'tabby-tauri', 'src', 'index.ts'), 'utf8')
  const xtermSource = readFileSync(resolve(repoRoot, 'tabby-terminal', 'src', 'frontends', 'xtermFrontend.ts'), 'utf8')

  assert.match(
    entry,
    /pluginModule\('terminal'[\s\S]*pluginModule\('tauri'/,
    'Tauri ConfigProvider must load after terminal defaults so it can override Tauri-only performance defaults',
  )
  assert.doesNotMatch(tauriSource, /TAURI_DEFAULT_SCROLLBACK_LINES/)
  assert.doesNotMatch(tauriSource, /sixel: false/)
  assert.match(xtermSource, /const TERMINAL_SCROLLBACK_DEFAULT_LINES = 25_000/)
  assert.doesNotMatch(xtermSource, /TERMINAL_SCROLLBACK_MAX_LINES/)
  assert.match(xtermSource, /function normalizeScrollbackLines \(value: unknown\): number/)
  assert.match(
    xtermSource,
    /if \(!Number\.isFinite\(parsed\) \|\| parsed < 0\) \{[\s\S]*return TERMINAL_SCROLLBACK_DEFAULT_LINES[\s\S]*return Math\.floor\(parsed\)/,
    'xterm should only reject invalid scrollback values and must preserve valid user-provided sizes',
  )
  assert.match(
    xtermSource,
    /this\.xterm\.options\.scrollback = normalizeScrollbackLines\(config\.terminal\.scrollbackLines\)/,
    'xterm must normalize scrollback before allocating its backing buffer',
  )
  assert.doesNotMatch(
    xtermSource,
    /this\.xterm\.options\.scrollback = config\.terminal\.scrollbackLines/,
    'xterm should not apply raw scrollback config values directly',
  )
})

test('Tauri renderer provides readline APIs used by terminal spinners and readline input mode', async () => {
  const configModule = await import(pathToFileURL(resolve(repoRoot, 'app', 'webpack.config.tauri.mjs')).href)
  const config = configModule.default()
  const polyfillPath = resolve(repoRoot, 'app', 'src', 'tauri-polyfills', 'readline.ts')

  assert.equal(config.resolve.fallback.readline, polyfillPath)
  assert.equal(existsSync(polyfillPath), true, 'readline fallback polyfill must exist for the Tauri WebView renderer')

  const source = existsSync(polyfillPath) ? readFileSync(polyfillPath, 'utf8') : ''
  const outputText = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText

  const exports = {}
  const module = { exports }
  Function('exports', 'module', outputText)(exports, module)

  const writes = []
  const stream = { write: value => { writes.push(value); return true } }
  assert.equal(typeof module.exports.clearLine, 'function')
  assert.equal(typeof module.exports.cursorTo, 'function')
  assert.equal(typeof module.exports.createInterface, 'function')

  module.exports.clearLine(stream, 0)
  module.exports.cursorTo(stream, 0)
  assert.ok(writes.some(value => String(value).includes('\x1b[2K')), 'clearLine should write an ANSI clear sequence')
  assert.ok(writes.some(value => String(value).includes('\r')), 'cursorTo should move back to the start of the line')

  const listeners = new Map()
  const input = {
    on: (event, handler) => listeners.set(event, handler),
    off: event => listeners.delete(event),
  }
  const output = { write: value => { writes.push(value); return true } }
  const readline = module.exports.createInterface({ input, output, prompt: '> ' })
  let line = null
  readline.on('line', value => { line = value })
  readline.prompt()
  listeners.get('data')?.(Buffer.from('whoami\r'))

  assert.equal(line, 'whoami')
  assert.ok(writes.includes('> '))
  readline.close()
})

test('Tauri renderer process provider must not seed fake OS environment paths', () => {
  const processProvider = readFileSync(resolve(repoRoot, 'app', 'src', 'tauri-providers', 'process.ts'), 'utf8')
  const webpackConfig = readFileSync(resolve(repoRoot, 'app', 'webpack.config.tauri.mjs'), 'utf8')

  assert.doesNotMatch(processProvider, /\bPATH:\s*['"]{2}/, 'process.env.PATH must not be seeded as blank')
  assert.doesNotMatch(processProvider, /\bPath:\s*['"]{2}/, 'process.env.Path must not be seeded as blank')
  assert.doesNotMatch(webpackConfig, /\bPATH:\s*['"]{2}/, 'inline process.env.PATH must not be seeded as blank')
  assert.doesNotMatch(webpackConfig, /\bPath:\s*['"]{2}/, 'inline process.env.Path must not be seeded as blank')
  for (const key of ['TEMP', 'TMP', 'SystemRoot', 'WINDIR']) {
    assert.doesNotMatch(processProvider, new RegExp(`\\b${key}:\\s*['"]`), `process provider must not fake ${key}`)
    assert.doesNotMatch(webpackConfig, new RegExp(`\\b${key}:\\s*['"]`), `inline process provider must not fake ${key}`)
  }
  assert.match(processProvider, /TERM_PROGRAM\s*\?\?=\s*['"]Tabby['"]/, 'process provider may keep TERM_PROGRAM as a product identity hint')
  assert.doesNotMatch(webpackConfig, /globalThis\.process\s*=/, 'index.html must not install an inline fake Node process object')
})

test('Tauri bootstrap hydrates renderer process env from the Rust host', () => {
  const entry = readFileSync(resolve(repoRoot, 'app', 'src', 'entry.tauri.ts'), 'utf8')
  const main = readFileSync(resolve(repoRoot, 'tauri-app', 'src-tauri', 'src', 'main.rs'), 'utf8')

  assert.match(
    main,
    /struct BootstrapData[\s\S]*environment:\s*BTreeMap<String,\s*String>/,
    'bootstrap_data must carry the host environment instead of relying on hard-coded renderer compatibility code',
  )
  assert.match(
    main,
    /environment:\s*std::env::vars\(\)\.collect\(\)/,
    'the Rust host must provide the actual process environment to the renderer bootstrap',
  )
  assert.match(
    entry,
    /environment\?:\s*Record<string,\s*string>/,
    'Tauri bootstrap data must type the optional environment payload',
  )
  assert.match(
    entry,
    /Object\.assign\(process\.env,\s*tauriData\.environment\)/,
    'entry.tauri.ts must hydrate process.env before local terminal sessions expand environment variables',
  )
})

test('Tauri os provider derives home and temp directories from hydrated process env', () => {
  const osProvider = readFileSync(resolve(repoRoot, 'app', 'src', 'tauri-providers', 'os.ts'), 'utf8')

  assert.doesNotMatch(osProvider, /homedir\s*\(\)\s*:\s*string\s*\{\s*return ['"]C:\\\\Users['"]/, 'os.homedir must not return a generic Windows users directory')
  assert.doesNotMatch(osProvider, /tmpdir\s*\(\)\s*:\s*string\s*\{\s*return ['"]C:\\\\Windows\\\\Temp['"]/, 'os.tmpdir must not ignore the user temp directory')
  assert.match(osProvider, /process\.env\.USERPROFILE[\s\S]*process\.env\.HOME/, 'os.homedir should prefer real user profile/home values from hydrated process.env')
  assert.match(osProvider, /process\.env\.TMP[\s\S]*process\.env\.TEMP/, 'os.tmpdir should prefer real temp values from hydrated process.env')
})

test('Tauri local sessions must not let renderer fs provider/guard reject real working directories', () => {
  const localSession = readFileSync(resolve(repoRoot, 'tabby-local', 'src', 'session.ts'), 'utf8')
  const terminalService = readFileSync(resolve(repoRoot, 'tabby-local', 'src', 'services', 'terminal.service.ts'), 'utf8')
  const cli = readFileSync(resolve(repoRoot, 'tabby-local', 'src', 'cli.ts'), 'utf8')
  const tauriHost = readFileSync(resolve(repoRoot, 'tabby-tauri', 'src', 'index.ts'), 'utf8')
  const main = readFileSync(resolve(repoRoot, 'tauri-app', 'src-tauri', 'src', 'main.rs'), 'utf8')

  for (const [label, source] of [
    ['local Session', localSession],
    ['TerminalService', terminalService],
    ['Terminal CLI', cli],
  ]) {
    assert.doesNotMatch(source, /from ['"](?:fs|mz\/fs)['"]|require\(['"](?:fs|mz\/fs)['"]\)/, `${label} must not import Node fs in the Tauri graph`)
    assert.doesNotMatch(source, /fsSync\.existsSync|fs\.access|fs\.realpath|fs\.stat|fs\.lstat|fs\.exists/, `${label} must use PlatformService native path providers instead of renderer fs provider/guard`)
  }
  assert.match(localSession, /private platform: PlatformService/, 'local Session must depend on the platform path provider')
  assert.match(terminalService, /private platform: PlatformService/, 'TerminalService must validate CWD through the platform path provider')
  assert.match(cli, /private platform: PlatformService/, 'Terminal CLI path handling must use the platform path provider')
  assert.match(tauriHost, /override async pathExists[\s\S]*native_path_exists/, 'Tauri host must expose native path existence through PlatformService')
  assert.match(main, /fn native_path_exists/, 'Rust host must implement native_path_exists')
  assert.match(main, /native_path_exists,/, 'Rust host must register native_path_exists')
})

test('Tauri renderer fs provider/guard are provider-backed or explicit unsupported instead of silent fake OS results', () => {
  const fsGuardPath = resolve(repoRoot, 'app', 'src', 'tauri-guards', 'fs.ts')
  const fsPromisesProviderPath = resolve(repoRoot, 'app', 'src', 'tauri-providers', 'fs-promises.ts')
  const main = readFileSync(resolve(repoRoot, 'tauri-app', 'src-tauri', 'src', 'main.rs'), 'utf8')

  const fsGuardSource = readFileSync(fsGuardPath, 'utf8')
  const fsOutputText = ts.transpileModule(fsGuardSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const fsExports = {}
  const fsModule = { exports: fsExports }
  const require = specifier => {
    if (specifier === '../tauri-providers/fs-promises') {
      return {}
    }
    throw new Error(`Unexpected require in fs guard test: ${specifier}`)
  }
  Function('exports', 'module', 'require', fsOutputText)(fsExports, fsModule, require)

  for (const method of ['readdirSync', 'existsSync', 'statSync', 'unlinkSync', 'mkdirSync', 'open', 'close', 'closeSync', 'realpathSync']) {
    assert.throws(
      () => fsModule.exports[method]('C:\\Temp\\example.txt'),
      /Tauri renderer/,
      `sync fs.${method} must fail explicitly instead of returning fake filesystem state`,
    )
  }

  const fsPromisesSource = readFileSync(fsPromisesProviderPath, 'utf8')
  const promisesOutputText = ts.transpileModule(fsPromisesSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const promiseExports = {}
  const promiseModule = { exports: promiseExports }
  const invocations = []
  const window = {
    __TAURI__: {
      core: {
        invoke: async (command, args) => {
          invocations.push({ command, args })
          switch (command) {
            case 'native_fs_stat':
              return { path: args.path, name: 'example.txt', size: 5, mode: 0o644, isDirectory: false }
            case 'native_fs_readdir':
              return [{ path: `${args.path}\\example.txt`, name: 'example.txt', size: 5, mode: 0o644, isDirectory: false }]
            case 'native_fs_read_text':
              return 'hello'
            case 'native_fs_realpath':
              return 'C:\\Temp\\example.txt'
            default:
              return undefined
          }
        },
      },
    },
  }
  Function('exports', 'module', 'window', promisesOutputText)(promiseExports, promiseModule, window)

  return Promise.resolve()
    .then(async () => {
      const stat = await promiseModule.exports.stat('C:\\Temp\\example.txt')
      assert.equal(stat.isFile(), true)
      assert.equal(stat.isDirectory(), false)
      assert.equal(stat.size, 5)
      assert.deepEqual(await promiseModule.exports.readdir('C:\\Temp'), ['example.txt'])
      assert.equal(await promiseModule.exports.readFile('C:\\Temp\\example.txt', 'utf8'), 'hello')
      assert.equal(await promiseModule.exports.realpath('C:\\Temp\\example.txt'), 'C:\\Temp\\example.txt')
      await promiseModule.exports.writeFile('C:\\Temp\\example.txt', 'hello')
      await promiseModule.exports.mkdir('C:\\Temp\\nested', { recursive: true })
      await promiseModule.exports.access('C:\\Temp\\example.txt')
      await promiseModule.exports.unlink('C:\\Temp\\example.txt')
    })
    .then(() => {
      for (const command of [
        'native_fs_stat',
        'native_fs_readdir',
        'native_fs_read_text',
        'native_fs_write_text',
        'native_fs_mkdir',
        'native_fs_access',
        'native_fs_realpath',
        'native_fs_unlink',
      ]) {
        assert.ok(invocations.some(call => call.command === command), `fs/promises provider must invoke ${command}`)
        assert.match(main, new RegExp(`fn ${command}`), `Rust must implement ${command}`)
        assert.match(main, new RegExp(`${command},`), `Tauri invoke handler must register ${command}`)
      }
    })
})

test('Tauri vault crypto uses native provider instead of Node crypto in the renderer graph', () => {
  const vaultService = readFileSync(resolve(repoRoot, 'tabby-core', 'src', 'services', 'vault.service.ts'), 'utf8')
  const tauriHost = readFileSync(resolve(repoRoot, 'tabby-tauri', 'src', 'index.ts'), 'utf8')
  const vaultRust = readFileSync(resolve(repoRoot, 'tauri-app', 'src-tauri', 'src', 'vault.rs'), 'utf8')
  const main = readFileSync(resolve(repoRoot, 'tauri-app', 'src-tauri', 'src', 'main.rs'), 'utf8')

  assert.doesNotMatch(vaultService, /from ['"]crypto['"]|require\(['"]crypto['"]\)/, 'VaultService must not import Node crypto in the Tauri graph')
  assert.doesNotMatch(vaultService, /from ['"]util['"]|promisify/, 'VaultService must not depend on Node util.promisify for crypto')
  assert.match(vaultService, /export class VaultCryptoProvider/, 'VaultService must use an injectable crypto provider boundary')
  assert.match(tauriHost, /export class TauriVaultCryptoProvider extends VaultCryptoProvider/, 'Tauri must override vault crypto with a native provider')
  for (const command of ['vault_encrypt', 'vault_decrypt', 'vault_random_bytes']) {
    assert.match(tauriHost, new RegExp(`['"]${command}['"]`), `Tauri vault provider must invoke ${command}`)
    assert.match(main, new RegExp(`fn ${command}`), `Rust host must implement ${command}`)
    assert.match(main, new RegExp(`${command},`), `Rust host must register ${command}`)
  }
  assert.match(vaultRust, /decrypts_node_produced_vault_fixture/, 'Rust vault provider must keep Node-produced vault compatibility covered by fixtures')
  assert.match(vaultRust, /BAD_DECRYPT/, 'Rust vault provider must report redacted decrypt failures')
})

test('Tauri net provider is provider-backed for Telnet TCP sockets and explicit about server sockets', async () => {
  const netProviderPath = resolve(repoRoot, 'app', 'src', 'tauri-providers', 'net.ts')
  const netProviderSource = readFileSync(netProviderPath, 'utf8')
  const main = readFileSync(resolve(repoRoot, 'tauri-app', 'src-tauri', 'src', 'main.rs'), 'utf8')
  const lib = readFileSync(resolve(repoRoot, 'tauri-app', 'src-tauri', 'src', 'lib.rs'), 'utf8')

  assert.doesNotMatch(
    netProviderSource,
    /write\s*\(\)\s*:\s*boolean\s*\{\s*return false\s*\}/,
    'net.Socket.write must not silently drop Telnet bytes',
  )
  assert.doesNotMatch(
    netProviderSource,
    /function\s+connect\s*\(\)\s*:\s*Socket\s*\{\s*return new Socket\(\)\s*\}/,
    'net.connect must not return an inert fake socket',
  )

  const outputText = ts.transpileModule(netProviderSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText

  const exports = {}
  const module = { exports }
  const invocations = []
  let streamChannel = null
  const window = {
    __TAURI__: {
      core: {
        Channel: class Channel {
          constructor (onmessage) {
            this.onmessage = onmessage
          }
        },
        invoke: async (command, args) => {
          invocations.push({ command, args })
          if (command === 'native_tcp_connect') {
            return { session: { session_id: 'tcp-1', kind: 'tcp', state: 'running' } }
          }
          if (command === 'native_tcp_stream') {
            streamChannel = args.channel
            return { session_id: args.sessionId, kind: 'tcp', state: 'running' }
          }
          return { session_id: args?.sessionId ?? 'tcp-1', kind: 'tcp', state: 'running' }
        },
      },
    },
  }
  Function('exports', 'module', 'window', outputText)(exports, module, window)

  const socket = new module.exports.Socket()
  const events = []
  socket.on('connect', () => events.push('connect'))
  socket.on('data', data => events.push(data.toString('utf8')))
  socket.connect(2323, '127.0.0.1')
  await new Promise(resolvePromise => setImmediate(resolvePromise))

  assert.deepEqual(
    invocations.map(call => call.command).slice(0, 2),
    ['native_tcp_connect', 'native_tcp_stream'],
    'Socket.connect must open and stream through Rust TCP commands',
  )
  assert.equal(invocations[0].args.request.host, '127.0.0.1')
  assert.equal(invocations[0].args.request.port, 2323)
  assert.ok(events.includes('connect'), 'Socket.connect should emit connect after the native stream starts')

  streamChannel.onmessage({ session_id: 'tcp-1', seq: 0, bytes: [104, 105] })
  await socket.write(Buffer.from('ping'))
  socket.destroy()
  await new Promise(resolvePromise => setImmediate(resolvePromise))

  assert.ok(events.includes('hi'), 'native TCP stream bytes should be emitted as Buffer data events')
  assert.ok(invocations.some(call => call.command === 'native_tcp_ack' && call.args.length === 2))
  assert.ok(invocations.some(call => call.command === 'native_tcp_write' && call.args.bytes.join(',') === '112,105,110,103'))
  assert.ok(invocations.some(call => call.command === 'native_tcp_close'))
  assert.throws(() => module.exports.createServer(), /unsupported/i)

  for (const command of [
    'native_tcp_connect',
    'native_tcp_stream',
    'native_tcp_write',
    'native_tcp_ack',
    'native_tcp_close',
  ]) {
    assert.match(main, new RegExp(`fn ${command}`), `Rust must implement ${command}`)
    assert.match(main, new RegExp(`${command},`), `Tauri invoke handler must register ${command}`)
  }
  assert.match(lib, /pub mod tcp;/, 'Rust TCP provider must live outside renderer compatibility code')
})

test('Tauri renderer must not load the Node SOCKS proxy package during startup', async () => {
  const configModule = await import(pathToFileURL(resolve(repoRoot, 'app', 'webpack.config.tauri.mjs')).href)
  const config = configModule.default()
  const guardPath = resolve(repoRoot, 'app', 'src', 'tauri-guards', 'socksv5.ts')

  assert.equal(
    config.resolve.alias['@luminati-io/socksv5'],
    guardPath,
    'Tauri must alias @luminati-io/socksv5 because the package calls fs.readdirSync at module load and whitescreens release startup',
  )
  assert.equal(existsSync(guardPath), true, 'the Tauri socksv5 guard must exist')

  const guardSource = readFileSync(guardPath, 'utf8')
  assert.doesNotMatch(guardSource, /from ['"]fs['"]|require\(['"]fs['"]\)/, 'socksv5 guard must not import renderer fs provider/guard')
  assert.match(guardSource, /createServer[\s\S]*unsupported|unsupported[\s\S]*createServer/i, 'dynamic SOCKS forwarding must fail explicitly when invoked')
})

test('Tauri tls guard rejects real TLS operations instead of returning fake sockets or contexts', () => {
  const tlsGuardPath = resolve(repoRoot, 'app', 'src', 'tauri-guards', 'tls.ts')
  const tlsGuardSource = readFileSync(tlsGuardPath, 'utf8')

  assert.doesNotMatch(
    tlsGuardSource,
    /function\s+connect\s*\(\)\s*:\s*TLSSocket\s*\{\s*return new TLSSocket\(\)\s*\}/,
    'tls.connect must not return an inert fake TLSSocket',
  )
  assert.doesNotMatch(
    tlsGuardSource,
    /createSecureContext\s*=\s*\(\)\s*=>\s*\(\{\}\)/,
    'tls.createSecureContext must not return a fake empty TLS context',
  )

  const outputText = ts.transpileModule(tlsGuardSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const exports = {}
  const module = { exports }
  Function('exports', 'module', outputText)(exports, module)

  assert.throws(() => module.exports.connect(), /unsupported|not available/i)
  assert.throws(() => module.exports.createSecureContext(), /unsupported|not available/i)
})

test('Tauri Windows shell provider derives stock shell paths from hydrated environment', () => {
  const tauriHostSource = readFileSync(resolve(repoRoot, 'tabby-tauri', 'src', 'index.ts'), 'utf8')

  assert.match(
    tauriHostSource,
    /process\.env\.SystemRoot[\s\S]*process\.env\.WINDIR/,
    'stock Windows shell paths should use the real SystemRoot/WINDIR instead of assuming C:\\Windows',
  )
  assert.match(
    tauriHostSource,
    /process\.env\.ProgramW6432[\s\S]*process\.env\.ProgramFiles/,
    'PowerShell 7 path should use real Program Files environment variables instead of assuming C:\\Program Files',
  )
})

test('Tauri openExternal is backed by a native Windows provider, not a no-op shim', () => {
  const tauriHostSource = readFileSync(resolve(repoRoot, 'tabby-tauri', 'src', 'index.ts'), 'utf8')
  const main = readFileSync(resolve(repoRoot, 'tauri-app', 'src-tauri', 'src', 'main.rs'), 'utf8')

  assert.match(
    tauriHostSource,
    /openExternal\s*\(url:\s*string\):\s*Promise<void>\s*\{\s*return invoke<void>\(['"]open_external['"],\s*\{\s*url\s*\}\)/,
    'renderer PlatformService.openExternal should delegate to the Tauri provider command',
  )
  assert.doesNotMatch(
    main,
    /fn open_external\(_url:\s*String\)\s*->\s*Result<\(\),\s*String>\s*\{\s*Ok\(\(\)\)\s*\}/,
    'Rust open_external must not silently report success without opening the target',
  )
  assert.match(
    main,
    /ShellExecuteW/,
    'Windows Tauri host should use the native ShellExecuteW API instead of a Node/Electron shim or shell subprocess',
  )
})

test('Tauri tab header context menu renders a theme-aware Tabby DOM menu instead of a native Windows menu', () => {
  const tauriHostSource = readFileSync(resolve(repoRoot, 'tabby-tauri', 'src', 'index.ts'), 'utf8')
  const contextMenuSource = readFileSync(resolve(repoRoot, 'tabby-tauri', 'src', 'contextMenu.ts'), 'utf8')
  const tabHeaderSource = readFileSync(resolve(repoRoot, 'tabby-core', 'src', 'components', 'tabHeader.component.ts'), 'utf8')

  assert.doesNotMatch(
    tauriHostSource,
    /popupContextMenu\s*\([^)]*\)\s*:\s*void\s*\{\s*unsupported\(['"]native context menu['"]\)\s*\}/,
    'tab options button must not call an unsupported/no-op context menu provider',
  )
  assert.doesNotMatch(
    tauriHostSource,
    /window\.__TAURI__\?\.menu[\s\S]*Menu[\s\S]*\.popup\(/,
    'Tauri tab context menus must not use Windows/native Tauri menu rendering',
  )
  assert.match(
    tauriHostSource,
    /popupContextMenu\s*\([^)]*\)\s*:\s*void\s*\{\s*showTabbyContextMenu\(menu,\s*event\)/,
    'Tauri tab context menus should render through the in-WebView Tabby menu helper',
  )
  assert.match(
    contextMenuSource,
    /tabby-tauri-context-menu[\s\S]*dropdown-menu[\s\S]*\$\{PANEL_CLASS\}/,
    'Tauri context menus should use Tabby/Bootstrap dropdown styling inside the WebView',
  )
  assert.doesNotMatch(
    contextMenuSource,
    /\bbg-dark\b|#181818|var\(--theme-bg-more,\s*#[0-9a-fA-F]+\)/,
    'Tauri context menus must not force a dark class or hard-coded dark background fallback',
  )
  assert.match(
    contextMenuSource,
    /--bs-dropdown-bg:\s*var\(--theme-bg-more\);[\s\S]*--bs-dropdown-link-hover-bg:\s*var\(--theme-bg-more-2\);/,
    'Tauri context menus must inherit active Tabby theme variables so light and dark schemes both work',
  )
  assert.match(
    contextMenuSource,
    /item\.type === ['"]separator['"][\s\S]*dropdown-divider/,
    'Tabby separators must render as dropdown dividers',
  )
  assert.match(
    contextMenuSource,
    /item\.type === ['"]checkbox['"][\s\S]*item\.checked[\s\S]*✓/,
    'Tabby checkbox/radio menu states must be preserved in the DOM menu',
  )
  assert.match(
    contextMenuSource,
    /item\.submenu\?\.length[\s\S]*tabby-tauri-context-menu-caret/,
    'Tabby submenu entries must remain available from the theme-aware DOM menu',
  )
  assert.match(
    tabHeaderSource,
    /onContextMenu[\s\S]*\$event\.preventDefault\(\)[\s\S]*\$event\.stopPropagation\(\)/,
    'clicking the tab options button should open only the menu instead of bubbling into tab selection/drag handlers',
  )
})

test('xterm resize recovery refits and repaints after collapsed window geometry', () => {
  const xtermFrontendSource = readFileSync(resolve(repoRoot, 'tabby-terminal', 'src', 'frontends', 'xtermFrontend.ts'), 'utf8')
  const baseTerminalTabSource = readFileSync(resolve(repoRoot, 'tabby-terminal', 'src', 'api', 'baseTerminalTab.component.ts'), 'utf8')

  assert.match(
    xtermFrontendSource,
    /proposeDimensions\(\)[\s\S]*dimensions\.cols < 2[\s\S]*dimensions\.rows < 1[\s\S]*return/,
    'xterm resize must ignore unusable collapsed geometry instead of resizing the PTY/display to near-zero cells',
  )
  assert.match(
    xtermFrontendSource,
    /requestAnimationFrame[\s\S]*setTimeout[\s\S]*applyResize/,
    'xterm resize must schedule deferred post-layout refits for Tauri/WebView restore-after-shrink cases',
  )
  assert.match(
    xtermFrontendSource,
    /setTimeout\(\(\)\s*=>\s*\{[\s\S]*this\.applyResize\(\)[\s\S]*\},\s*350\)/,
    'xterm resize must keep one late recovery refit after the WebView reports its final restored size',
  )
  assert.match(
    xtermFrontendSource,
    /resizeAndRepaint\s*\(\)\s*:\s*void[\s\S]*scheduleResizePasses\(\)/,
    'xterm resize recovery must expose a public refit/repaint hook for host-window resize and visibility recovery events',
  )
  assert.match(
    xtermFrontendSource,
    /private resizeObserverFrame: number \| null = null[\s\S]*private scheduleObservedResize \(\): void[\s\S]*if \(this\.resizeObserverFrame !== null\)[\s\S]*requestAnimationFrame\(\(\) => \{[\s\S]*this\.resizeHandler\(\)/,
    'ResizeObserver bursts should be coalesced into one resize recovery pass per animation frame',
  )
  assert.match(
    xtermFrontendSource,
    /private cancelObservedResize \(\): void[\s\S]*cancelAnimationFrame\(this\.resizeObserverFrame\)[\s\S]*this\.resizeObserverFrame = null/,
    'pending ResizeObserver work must be cancelled when the frontend is detached or destroyed',
  )
  assert.match(
    xtermFrontendSource,
    /private hostEventDisposers: \(\(\) => void\)\[\] = \[\][\s\S]*private detachHostEvents \(\): void[\s\S]*this\.hostEventDisposers\.splice\(0\)/,
    'host and window event listeners should be owned by the xterm frontend and cleaned up on detach',
  )
  assert.match(
    xtermFrontendSource,
    /detach \(_host: HTMLElement\): void \{[\s\S]*this\.cancelObservedResize\(\)[\s\S]*this\.detachHostEvents\(\)[\s\S]*resizeObserver\?\.disconnect/,
    'detaching an xterm frontend should stop resize work and release DOM listeners without waiting for destroy',
  )
  assert.match(
    xtermFrontendSource,
    /_renderService\?\.clear\?\.\(\)[\s\S]*_renderService\?\.handleResize\?\.\(this\.xterm\.cols,\s*this\.xterm\.rows\)[\s\S]*xterm\.refresh\(0,\s*Math\.max\(0,\s*this\.xterm\.rows - 1\)\)/,
    'xterm resize must resize and repaint the active renderer after fit so blank regions are redrawn when the window expands again',
  )
  const repaintAfterResize = xtermFrontendSource.match(
    /private repaintAfterResize \(\): void \{([\s\S]*?)\n    \}\n\n    async attach/,
  )
  assert.ok(repaintAfterResize, 'xterm resize recovery must keep its repaint helper')
  assert.doesNotMatch(
    repaintAfterResize[1],
    /clearTextureAtlas/,
    'ordinary resize recovery must not clear the glyph atlas shared by multiple terminals',
  )
  assert.match(
    xtermFrontendSource,
    /displayMetricsChanged\$[\s\S]*webGLAddon\?\.clearTextureAtlas\(\)/,
    'display metric changes must still invalidate the WebGL glyph atlas when its scale changes',
  )
  assert.match(
    baseTerminalTabSource,
    /const\s+refreshTerminalLayout\s*=[\s\S]*frontend\.resizeAndRepaint\(\)/,
    'terminal tabs must explicitly ask xterm to refit after host-window layout changes',
  )
  assert.match(
    baseTerminalTabSource,
    /hostWindow\.windowMoved\$,\s*maybeConfigure/,
    'Tauri host window resize/move notifications must still drive the terminal layout recovery path',
  )
})

test('Tauri unsupported surface is tracked and source-of-truth consistent', () => {
  const matrix = readFileSync(resolve(repoRoot, 'docs', 'tauri', 'migration', 'tauri-unsupported-matrix.md'), 'utf8')
  const tauriHostSource = readFileSync(resolve(repoRoot, 'tabby-tauri', 'src', 'index.ts'), 'utf8')
  const tauriHostTypes = readFileSync(resolve(repoRoot, 'tabby-tauri', 'typings', 'index.d.ts'), 'utf8')
  const providers = readFileSync(resolve(repoRoot, 'tauri-app', 'src', 'tauri-providers.ts'), 'utf8')
  const registry = readFileSync(resolve(repoRoot, 'tauri-app', 'src', 'tauri-tabby-session-registry.ts'), 'utf8')

  for (const requiredEntry of [
    'PlatformService.exec(app, argv)',
    'PlatformService.openPath(path)',
    'HostAppService.newWindow()',
    'Auto-update',
    'Docking',
    'Sync `fs` guard',
    'Node `http`/`https`',
    'Node `tls`',
    'net.createServer',
    'Dynamic SOCKS forwarding',
    'Electron `russh` APIs',
  ]) {
    assert.match(matrix, new RegExp(requiredEntry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `unsupported matrix must track ${requiredEntry}`)
  }

  assert.doesNotMatch(
    tauriHostTypes,
    /UnsupportedDockingService/,
    'Tauri typings must not expose an unsupported docking service when runtime intentionally omits DockingService',
  )
  assert.doesNotMatch(
    providers,
    /UnsupportedDockingService|token:\s*['"]DockingService['"]/,
    'Tauri provider helper must not resurrect DockingService while docking capabilities are unsupported',
  )
  assert.doesNotMatch(
    registry,
    /UnsupportedDockingService|\bDockingService\b/,
    'Tauri Angular module blueprint must not import or register DockingService while runtime omits it',
  )

  const unsupportedCalls = [...tauriHostSource.matchAll(/unsupported(?:Async)?(?:<[^>]+>)?\(['"]([^'"]+)['"]\)/g)].map(match => match[1]).sort()
  assert.deepEqual(
    unsupportedCalls,
    ['auto-update'],
    'runtime unsupported helpers should only remain for update actions hidden behind updater availability gates',
  )
})

test('Tauri unsupported SSH matrix enumerates each provider feature with status and gates', () => {
  const matrix = readFileSync(resolve(repoRoot, 'docs', 'tauri', 'migration', 'tauri-unsupported-matrix.md'), 'utf8')

  for (const status of [
    'graph-excluded',
    'explicitly-unsupported',
    'hidden-by-capability',
    'provider-in-progress',
    'provider-backed',
    'deleted-shim',
  ]) {
    assert.match(matrix, new RegExp(`\\b${status}\\b`), `unsupported matrix must define ${status}`)
  }

  for (const heading of [
    'Frontend owner',
    'Provider typing',
    'Rust command/module',
    'Command registration',
    'Capability/security review',
    'Tests',
    'UX visibility',
    'Removal gate',
  ]) {
    assert.match(matrix, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `unsupported matrix must track ${heading}`)
  }

  for (const feature of [
    'SSH agent auth',
    'SSH keyboard-interactive auth',
    'SSH jump host',
    'SSH agent forwarding',
    'SSH X11 forwarding',
    'SSH proxy command',
    'SSH port forwarding',
    'SSH SOCKS proxy',
    'SSH HTTP proxy',
    'SSH multiple private keys',
  ]) {
    assert.match(matrix, new RegExp(`\\|\\s*${feature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|`), `unsupported matrix must have an individual row for ${feature}`)
  }
})

test('Tauri SSH frontend exposes typed keyboard-interactive prompts instead of Subject<never>', () => {
  const tauriHostSource = readFileSync(resolve(repoRoot, 'tabby-tauri', 'src', 'index.ts'), 'utf8')
  const providers = readFileSync(resolve(repoRoot, 'tauri-app', 'src', 'tauri-providers.ts'), 'utf8')

  assert.match(tauriHostSource, /KeyboardInteractivePrompt/, 'Tauri host must use the shared KeyboardInteractivePrompt contract')
  assert.doesNotMatch(tauriHostSource, /keyboardInteractivePrompt\s*=\s*new Subject<never>\(\)/, 'keyboard-interactive prompt stream must not be Subject<never>')
  assert.match(tauriHostSource, /keyboardInteractivePrompt\.next\(/, 'Tauri host must emit keyboard-interactive prompt objects')
  assert.match(providers, /SshKeyboardInteractivePromptEvent/, 'provider typings must define prompt channel events')
  assert.match(providers, /SshKeyboardInteractiveResponseRequest/, 'provider typings must define prompt response requests')
})

test('Tauri SSH port forwarding is provider-backed for local dynamic and remote modes', () => {
  const tauriHostSource = readFileSync(resolve(repoRoot, 'tabby-tauri', 'src', 'index.ts'), 'utf8')
  const providers = readFileSync(resolve(repoRoot, 'tauri-app', 'src', 'tauri-providers.ts'), 'utf8')
  const mainSource = readFileSync(resolve(repoRoot, 'tauri-app', 'src-tauri', 'src', 'main.rs'), 'utf8')
  const sshSource = readFileSync(resolve(repoRoot, 'tauri-app', 'src-tauri', 'src', 'ssh.rs'), 'utf8')

  assert.match(tauriHostSource, /PortForwardType\.Local/, 'Tauri host must distinguish local forwards from unsupported forward types')
  assert.match(tauriHostSource, /PortForwardType\.Dynamic/, 'Tauri host must distinguish dynamic SOCKS forwards from unsupported forward types')
  assert.match(tauriHostSource, /PortForwardType\.Remote/, 'Tauri host must distinguish remote forwards from unsupported forward types')
  assert.match(tauriHostSource, /ssh_start_local_port_forward/, 'Tauri host must call the Rust local port-forward provider')
  assert.match(tauriHostSource, /ssh_start_dynamic_port_forward/, 'Tauri host must call the Rust dynamic SOCKS provider')
  assert.match(tauriHostSource, /ssh_start_remote_port_forward/, 'Tauri host must call the Rust remote port-forward provider')
  assert.match(tauriHostSource, /ssh_stop_port_forward/, 'Tauri host must stop Rust local port forwards')
  assert.doesNotMatch(tauriHostSource, /Unsupported Tauri SSH profile features: remote port forwarding/, 'Tauri host must not reject remote forwarding once provider-backed')
  assert.match(providers, /SshLocalPortForwardRequest/, 'provider typings must define local port-forward requests')
  assert.match(providers, /SshDynamicPortForwardRequest/, 'provider typings must define dynamic SOCKS port-forward requests')
  assert.match(providers, /SshRemotePortForwardRequest/, 'provider typings must define remote port-forward requests')
  assert.match(providers, /startLocalPortForward/, 'provider adapter must expose local port-forward start')
  assert.match(providers, /startDynamicPortForward/, 'provider adapter must expose dynamic SOCKS port-forward start')
  assert.match(providers, /startRemotePortForward/, 'provider adapter must expose remote port-forward start')
  assert.match(mainSource, /ssh_start_local_port_forward/, 'Tauri main command registry must expose local port-forward start')
  assert.match(mainSource, /ssh_start_dynamic_port_forward/, 'Tauri main command registry must expose dynamic SOCKS port-forward start')
  assert.match(mainSource, /ssh_start_remote_port_forward/, 'Tauri main command registry must expose remote port-forward start')
  assert.match(mainSource, /ssh_stop_port_forward/, 'Tauri main command registry must expose local port-forward stop')
  assert.match(sshSource, /channel_open_direct_tcpip/, 'Rust SSH provider must use russh direct-tcpip channels')
  assert.match(sshSource, /SOCKS5/, 'Rust SSH provider must own the SOCKS5 listener path for dynamic forwarding')
  assert.match(sshSource, /tcpip_forward/, 'Rust SSH provider must request server-side tcpip-forward for remote forwarding')
})

test('SSH profile settings gates unsupported Tauri SSH controls through a capability snapshot', () => {
  const settingsSource = readFileSync(resolve(repoRoot, 'tabby-ssh', 'src', 'components', 'sshProfileSettings.component.ts'), 'utf8')
  const settingsTemplate = readFileSync(resolve(repoRoot, 'tabby-ssh', 'src', 'components', 'sshProfileSettings.component.pug'), 'utf8')

  for (const feature of [
    'agentAuth',
    'keyboardInteractive',
    'multiplePrivateKeys',
    'jumpHost',
    'proxyCommand',
    'socksProxy',
    'httpProxy',
    'portForwarding',
    'x11Forwarding',
    'agentForwarding',
  ]) {
    assert.match(settingsSource, new RegExp(`${feature}:\\s*(?:true|false)`), `Tauri SSH capabilities must define ${feature}`)
  }

  for (const gate of [
    'isSshFeatureAvailable("proxyCommand")',
    'isSshFeatureAvailable("jumpHost")',
    'isSshFeatureAvailable("socksProxy")',
    'isSshFeatureAvailable("httpProxy")',
    'isSshFeatureAvailable("agentAuth")',
    'isSshFeatureAvailable("keyboardInteractive")',
    'isSshFeatureAvailable("portForwarding")',
    'isSshFeatureAvailable("x11Forwarding")',
    'isSshFeatureAvailable("agentForwarding")',
    'canAddPrivateKey()',
  ]) {
    assert.match(settingsTemplate, new RegExp(gate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `SSH profile settings must gate ${gate}`)
  }

  assert.match(
    settingsTemplate,
    /This option is not available in the Tauri SSH provider yet/,
    'disabled Tauri SSH controls must show localized unavailable text',
  )
  assert.match(settingsSource, /portForwarding:\s*true/, 'Tauri SSH should expose local TCP port forwarding')
  assert.match(settingsSource, /getSupportedForwardTypes\s*\(\)/, 'Tauri SSH settings must pass per-provider forwarding type support')
  assert.match(settingsTemplate, /\[supportedTypes\]='getSupportedForwardTypes\(\)'/, 'port forwarding editor must receive Tauri-supported forward types')
  assert.match(settingsSource, /\[PortForwardType\.Local,\s*PortForwardType\.Remote,\s*PortForwardType\.Dynamic\]/, 'Tauri SSH should expose all provider-backed port-forwarding modes')
})

test('Tauri SSH port-forwarding editor disables unsupported forward types per provider', () => {
  const source = readFileSync(resolve(repoRoot, 'tabby-ssh', 'src', 'components', 'sshPortForwardingConfig.component.ts'), 'utf8')
  const template = readFileSync(resolve(repoRoot, 'tabby-ssh', 'src', 'components', 'sshPortForwardingConfig.component.pug'), 'utf8')

  assert.match(source, /@Input\(\)\s+supportedTypes:\s*PortForwardType\[\]/, 'port-forwarding editor must accept a supportedTypes capability list')
  assert.match(source, /isForwardTypeSupported\s*\(/, 'port-forwarding editor must check forward type support before adding')
  assert.match(template, /\[disabled\]='!isForwardTypeSupported\(PortForwardType\.Remote\)'/, 'remote forwarding radio must remain capability-controlled')
  assert.match(template, /\[disabled\]='!isForwardTypeSupported\(PortForwardType\.Dynamic\)'/, 'dynamic forwarding radio must remain capability-controlled')
  assert.match(template, /Remote port forwarding is not available in the Tauri SSH provider yet/, 'remote unavailable warning must remain localizable for future capability gates')
})

test('Keyboard-interactive auth exposes cancel and rejects prompts on tab/session teardown', () => {
  const panelSource = readFileSync(resolve(repoRoot, 'tabby-ssh', 'src', 'components', 'keyboardInteractiveAuthPanel.component.ts'), 'utf8')
  const panelTemplate = readFileSync(resolve(repoRoot, 'tabby-ssh', 'src', 'components', 'keyboardInteractiveAuthPanel.component.pug'), 'utf8')
  const sshTabSource = readFileSync(resolve(repoRoot, 'tabby-ssh', 'src', 'components', 'sshTab.component.ts'), 'utf8')

  assert.match(panelSource, /cancel\s*\(\)\s*:\s*void[\s\S]*prompt\.reject\(\)[\s\S]*done\.emit\(/, 'keyboard-interactive panel must reject active prompt on cancel')
  assert.match(panelTemplate, /\(click\)='cancel\(\)'/, 'keyboard-interactive panel must expose a cancel button')
  assert.match(panelTemplate, /span\(translate\) Cancel/, 'keyboard-interactive cancel button must be visible/localizable')
  assert.match(sshTabSource, /private\s+clearActiveKIPrompt[\s\S]*activeKIPrompt\.reject\(\)[\s\S]*activeKIPrompt\s*=\s*null/, 'SSH tab must reject pending keyboard-interactive prompts before clearing them')
  assert.doesNotMatch(sshTabSource, /sessionChanged\$\.subscribe\(\(\) => \{\s*this\.activeKIPrompt = null\s*\}\)/, 'session change must not silently drop pending keyboard-interactive prompts')
})

test('Tauri native platform methods are provider-backed or explicit unsupported', () => {
  const tauriHostSource = readFileSync(resolve(repoRoot, 'tabby-tauri', 'src', 'index.ts'), 'utf8')
  const platformApi = readFileSync(resolve(repoRoot, 'tabby-core', 'src', 'api', 'platform.ts'), 'utf8')
  const platformApiTypes = readFileSync(resolve(repoRoot, 'tabby-core', 'typings', 'api', 'platform.d.ts'), 'utf8')
  const terminalTab = readFileSync(resolve(repoRoot, 'tabby-terminal', 'src', 'api', 'baseTerminalTab.component.ts'), 'utf8')
  const terminalSettings = readFileSync(resolve(repoRoot, 'tabby-terminal', 'src', 'components', 'terminalSettingsTab.component.ts'), 'utf8')
  const tauriHostTypes = readFileSync(resolve(repoRoot, 'tabby-tauri', 'typings', 'index.d.ts'), 'utf8')
  const main = readFileSync(resolve(repoRoot, 'tauri-app', 'src-tauri', 'src', 'main.rs'), 'utf8')
  const settingsTemplate = readFileSync(resolve(repoRoot, 'tabby-settings', 'src', 'components', 'settingsTab.component.pug'), 'utf8')
  const appRoot = readFileSync(resolve(repoRoot, 'tabby-core', 'src', 'components', 'appRoot.component.ts'), 'utf8')
  const updaterApi = readFileSync(resolve(repoRoot, 'tabby-core', 'src', 'services', 'updater.service.ts'), 'utf8')
  const capabilities = JSON.parse(readFileSync(resolve(repoRoot, 'tauri-app', 'src-tauri', 'capabilities', 'default.json'), 'utf8'))

  assert.match(
    platformApi,
    /abstract readClipboard\s*\(\):\s*string\s*\|\s*Promise<string>/,
    'PlatformService clipboard reads must allow an async native provider instead of forcing Tauri to return a fake sync string',
  )
  assert.match(
    platformApiTypes,
    /abstract readClipboard\s*\(\):\s*string\s*\|\s*Promise<string>/,
    'PlatformService typings must expose async native clipboard reads to plugins',
  )
  assert.match(
    terminalTab,
    /let data = await this\.platform\.readClipboard\(\)/,
    'terminal paste must await the native clipboard provider',
  )
  assert.match(
    tauriHostSource,
    /readClipboard\s*\(\):\s*Promise<string>\s*\{\s*return invoke<string>\(['"]read_clipboard_text['"]\)/,
    'Tauri readClipboard must delegate to the native clipboard command',
  )
  assert.match(
    tauriHostTypes,
    /readClipboard\s*\(\):\s*Promise<string>/,
    'Tauri host typings must not advertise a fake synchronous clipboard provider',
  )
  assert.match(
    tauriHostSource,
    /setClipboard\s*\(content:[\s\S]*invoke<void>\(['"]write_clipboard_text['"],\s*\{\s*text:\s*content\.text\s*\}\)/,
    'Tauri setClipboard must delegate to the native clipboard command',
  )
  assert.match(
    tauriHostSource,
    /showMessageBox\s*\(options:\s*MessageBoxOptions\):\s*Promise<MessageBoxResult>[\s\S]*this\.ngbModal\.open\(MessageBoxModalComponent/,
    'Tauri showMessageBox must use the shared in-app modal instead of a hidden native window',
  )
  assert.match(
    tauriHostSource,
    /openPath\s*\(path:\s*string\):\s*void\s*\{\s*void invoke<void>\(['"]open_path_allowlisted['"],\s*\{\s*path\s*\}\)/,
    'Tauri openPath must delegate to an allowlisted native provider instead of base Not implemented',
  )
  assert.match(
    main,
    /fn open_path_allowlisted/,
    'Rust host must implement open_path_allowlisted for visible openPath UI paths',
  )
  assert.match(
    main,
    /open_path_allowlisted,/,
    'Rust host must register open_path_allowlisted in the invoke handler',
  )
  assert.match(
    main,
    /validate_open_path_target[\s\S]*sndvol\.exe/,
    'Rust openPath provider must explicitly allow the WSL volume mixer path',
  )
  assert.doesNotMatch(
    terminalSettings,
    /platform\.exec\(['"]wsl\.exe['"]/,
    'WSL volume mixer UI must not spawn WSL just to ring the bell in Tauri',
  )
  assert.doesNotMatch(
    tauriHostSource,
    /showMessageBox\s*\([^)]*\):\s*Promise<MessageBoxResult>\s*\{\s*return Promise\.resolve\(\{\s*response:\s*0\s*\}\)/,
    'Tauri showMessageBox must not silently accept destructive confirmations',
  )
  assert.doesNotMatch(
    tauriHostSource,
    /dock\s*\(\):\s*void\s*\{\s*\/\* unsupported no-op \*\/\s*\}/,
    'unsupported docking must not silently no-op when invoked',
  )
  assert.doesNotMatch(
    tauriHostSource,
    /\{\s*provide:\s*DockingService/,
    'Tauri must not provide DockingService while display capabilities advertise docking as unsupported',
  )
  assert.doesNotMatch(
    tauriHostSource,
    /class UnsupportedDockingService/,
    'Tauri should hide docking settings via Optional DockingService absence instead of providing a fake service',
  )
  assert.match(
    tauriHostSource,
    /getOSRelease\s*\(\):\s*string\s*\{\s*return this\.bootstrapData\.os_release/,
    'Tauri getOSRelease must use Rust bootstrap metadata instead of navigator.userAgent',
  )
  assert.match(
    tauriHostSource,
    /getAppVersion\s*\(\):\s*string\s*\{\s*return this\.bootstrapData\.app_version/,
    'Tauri getAppVersion must use Rust package metadata instead of a hard-coded string',
  )
  assert.match(
    tauriHostSource,
    /getWinSCPPath\s*\(\):\s*string\s*\|\s*null\s*\{\s*return this\.bootstrapData\.winscp_path/,
    'Tauri getWinSCPPath must use Rust registry detection instead of always returning null',
  )
  assert.match(
    updaterApi,
    /isAvailable\s*=\s*true/,
    'UpdaterService must expose availability so Tauri can hide unsupported update UI',
  )
  assert.match(
    tauriHostSource,
    /class UnsupportedUpdaterService[\s\S]*override isAvailable = false[\s\S]*check\s*\(\):\s*Promise<boolean>\s*\{\s*return Promise\.resolve\(false\)/,
    'Tauri updater must be unavailable and checks must not throw from normal UI paths',
  )
  assert.match(
    settingsTemplate,
    /updater\.isAvailable[\s\S]*Check for updates/,
    'Settings update button must be hidden when updater provider is unavailable',
  )
  assert.match(
    appRoot,
    /this\.updater\.isAvailable[\s\S]*this\.config\.store\.enableAutomaticUpdates/,
    'Automatic update checks must not call an unavailable updater provider',
  )
  assert.match(
    tauriHostSource,
    /newWindow\s*\(\):\s*void\s*\{\s*void this\.createNewWindow\(\)/,
    'Tauri newWindow must be backed by a Tauri WebviewWindow provider instead of unsupported',
  )
  assert.match(
    tauriHostSource,
    /window\.__TAURI__\?\.webviewWindow[\s\S]*new WebviewWindow/,
    'Tauri newWindow must use the native WebviewWindow API',
  )
  assert.ok(
    capabilities.windows.includes('tabby-*'),
    'Tauri capabilities must apply to dynamically created tabby-* windows',
  )
  assert.ok(
    capabilities.permissions.includes('core:webview:allow-create-webview-window'),
    'Tauri capabilities must allow renderer-created WebviewWindow instances',
  )
  assert.match(
    tauriHostSource,
    /async exec\s*\(app:\s*string,\s*argv:\s*string\[\]\):\s*Promise<void>\s*\{\s*return invoke<void>\(['"]exec_allowlisted['"],\s*\{\s*app,\s*argv\s*\}\)/,
    'Tauri exec must delegate to an allowlisted Rust provider instead of unsupported',
  )
  assert.match(
    main,
    /fn exec_allowlisted/,
    'Rust host must implement exec_allowlisted for known safe process launch callsites',
  )
  assert.match(
    main,
    /exec_allowlisted,/,
    'Rust host must register exec_allowlisted in the invoke handler',
  )
  assert.doesNotMatch(
    tauriHostSource,
    /startUpload\s*\([^)]*\):\s*Promise<[^>]+>\s*\{\s*return Promise\.resolve\(\[\]\)/,
    'unsupported uploads must reject explicitly instead of returning an empty selection',
  )
  assert.doesNotMatch(
    tauriHostSource,
    /startDownload\s*\([^)]*\):\s*Promise<[^>]+>\s*\{\s*return Promise\.resolve\(null\)/,
    'unsupported downloads must reject explicitly instead of pretending the user cancelled',
  )
  for (const method of [
    'startUpload',
    'startUploadDirectory',
    'startDownload',
    'startDownloadDirectory',
    'pickDirectory',
  ]) {
    assert.doesNotMatch(
      tauriHostSource,
      new RegExp(`${method}\\s*\\([^)]*\\)[^{]*\\{\\s*return unsupportedAsync`),
      `Tauri ${method} must be backed by native file/dialog providers`,
    )
  }
  assert.match(
    tauriHostSource,
    /class TauriNativeFileUpload extends FileUpload/,
    'Tauri uploads must expose FileUpload backed by Rust file reads',
  )
  assert.match(
    tauriHostSource,
    /class TauriNativeFileDownload extends FileDownload/,
    'Tauri downloads must expose FileDownload backed by Rust file writes',
  )
  assert.match(
    tauriHostSource,
    /class TauriNativeDirectoryDownload extends DirectoryDownload/,
    'Tauri directory downloads must expose DirectoryDownload backed by Rust directory writes',
  )
  for (const command of [
    'read_clipboard_text',
    'write_clipboard_text',
    'native_pick_files',
    'native_pick_directory',
    'native_pick_save_file',
    'native_read_file_chunk',
    'native_prepare_download_file',
    'native_write_file_chunk',
    'native_upload_directory_tree',
    'native_prepare_download_directory',
    'native_create_directory',
  ]) {
    assert.match(main, new RegExp(`fn ${command}`), `Rust must implement ${command}`)
    assert.match(main, new RegExp(`${command},`), `Tauri invoke handler must register ${command}`)
  }
})

test('Tauri frameless Windows renders Tabby window controls in the tab bar', () => {
  const tauriHostSource = readFileSync(resolve(repoRoot, 'tabby-tauri', 'src', 'index.ts'), 'utf8')
  const appRootTemplate = readFileSync(resolve(repoRoot, 'tabby-core', 'src', 'components', 'appRoot.component.pug'), 'utf8')
  const appRootComponent = readFileSync(resolve(repoRoot, 'tabby-core', 'src', 'components', 'appRoot.component.ts'), 'utf8')
  const titleBarTemplate = readFileSync(resolve(repoRoot, 'tabby-core', 'src', 'components', 'titleBar.component.pug'), 'utf8')
  const windowControlsTemplate = readFileSync(resolve(repoRoot, 'tabby-core', 'src', 'components', 'windowControls.component.pug'), 'utf8')
  const tauriCapabilities = JSON.parse(readFileSync(resolve(repoRoot, 'tauri-app', 'src-tauri', 'capabilities', 'default.json'), 'utf8'))

  assert.match(
    tauriHostSource,
    /export class TauriWindowsPlatformService[\s\S]*override supportsWindowControls = true/,
    'Tauri uses decorations:false, so the renderer must advertise custom window controls',
  )
  assert.match(
    appRootComponent,
    /public platform: PlatformService/,
    'AppRoot must be able to read PlatformService capabilities',
  )
  assert.match(
    appRootComponent,
    /get hasTauriFramelessWindowControls[\s\S]*platform\.supportsWindowControls[\s\S]*decorations-false-tauri-drag-region/,
    'custom tab-bar controls should be limited to the Tauri frameless window strategy',
  )
  assert.match(
    appRootComponent,
    /get shouldShowTabBarWindowControls[\s\S]*hostApp\.platform === Platform\.Linux \|\| this\.hasTauriFramelessWindowControls/,
    'Linux behavior should be preserved while enabling Tauri frameless controls',
  )
  assert.match(
    appRootTemplate,
    /window-controls\.background\([\s\S]*shouldShowTabBarWindowControls/,
    'frameless Tauri Windows should render the same tab-bar window controls as Linux',
  )
  assert.match(
    tauriHostSource,
    /class TauriHostWindowService extends HostWindowService[\s\S]*supportsDirectQuit[\s\S]*return true/,
    'Tauri close buttons must quit the app directly after tab recovery saves tabs instead of destroying open tabs',
  )
  assert.match(
    tauriHostSource,
    /close \(\): void[\s\S]*invoke<void>\('quit'\)/,
    'Tauri direct quit must use the Rust quit command so the process exits instead of only closing the webview tab state',
  )
  assert.match(
    appRootTemplate,
    /window-controls-spacer\([\s\S]*shouldShowNativeWindowControlsSpacer/,
    'Windows native-titlebar spacer must not hide space where Tauri custom buttons render',
  )
  assert.match(
    appRootComponent,
    /get shouldUseTauriNativeDragRegions[\s\S]*hasTauriFramelessWindowControls[\s\S]*draggableRegions\.supported/,
    'Tauri drag regions must be feature-gated through display capabilities instead of relying on Electron-only CSS app-region behavior',
  )
  assert.match(
    appRootTemplate,
    /btn-space\.background\([\s\S]*\[attr\.data-tauri-drag-region\]=['"]shouldUseTauriNativeDragRegions[\s\S]*\? "" : null['"]/,
    'the tab bar blank drag area must use Tauri native data-tauri-drag-region so the whole WebView follows window moves',
  )
  assert.match(
    titleBarTemplate,
    /\.title\([\s\S]*\[attr\.data-tauri-drag-region\]=['"]shouldUseTauriNativeDragRegions \? "" : null['"]/,
    'the full titlebar drag target must use Tauri native drag regions when decorations are disabled',
  )
  assert.match(windowControlsTemplate, /hostWindow\.minimize\(\)/)
  assert.match(windowControlsTemplate, /hostWindow\.toggleMaximize\(\)/)
  assert.match(windowControlsTemplate, /closeWindow\(\)/)
  assert.ok(tauriCapabilities.permissions.includes('core:window:allow-minimize'))
  assert.ok(tauriCapabilities.permissions.includes('core:window:allow-toggle-maximize'))
  assert.ok(tauriCapabilities.permissions.includes('core:window:allow-close'))
})

test('Tauri SFTP uploads publish live progress inside Angular and complete only after the remote commit', () => {
  const tauriHostSource = readFileSync(resolve(repoRoot, 'tabby-tauri', 'src', 'index.ts'), 'utf8')
  const uploadClass = tauriHostSource.slice(
    tauriHostSource.indexOf('class TauriNativeFileUpload'),
    tauriHostSource.indexOf('class TauriNativeFileDownload'),
  )
  const sftpClass = tauriHostSource.slice(
    tauriHostSource.indexOf('class TauriSftpSession'),
    tauriHostSource.indexOf('export class TauriSshConnection'),
  )

  assert.match(
    uploadClass,
    /constructor\s*\([^)]*NgZone[^)]*\)[\s\S]*this\.zone\.run\(\(\)\s*=>\s*\{[\s\S]*increaseProgress/,
    'native upload chunks must notify Angular after Rust reads advance the transfer',
  )
  assert.doesNotMatch(
    uploadClass,
    /getCompletedBytes\(\)\s*>=\s*this\.getSize\(\)[\s\S]*setCompleted\(true\)/,
    'reading the final local chunk must not claim that the remote upload succeeded',
  )
  assert.match(
    sftpClass,
    /await this\.rename\(tempPath, path\)[\s\S]*this\.zone\.run\(\(\)\s*=>\s*transfer\.setCompleted\(true\)\)/,
    'an upload becomes successful only after the temporary remote file is committed',
  )
})

test('file transfer menu shows a numeric state and never presents cancelled work as successful', () => {
  const platformSource = readFileSync(resolve(repoRoot, 'tabby-core', 'src', 'api', 'platform.ts'), 'utf8')
  const componentSource = readFileSync(resolve(repoRoot, 'tabby-core', 'src', 'components', 'transfersMenu.component.ts'), 'utf8')
  const templateSource = readFileSync(resolve(repoRoot, 'tabby-core', 'src', 'components', 'transfersMenu.component.pug'), 'utf8')

  assert.match(
    platformSource,
    /isSuccessful\s*\(\): boolean\s*\{\s*return this\.completed && !this\.cancelled\s*\}/,
    'the transfer model must distinguish completed bytes from a successful operation',
  )
  assert.match(
    templateSource,
    /\{\{getProgress\(transfer\)\}\}%/,
    'active transfers should expose their numeric percentage instead of an unlabeled bar',
  )
  assert.match(
    templateSource,
    /transfer\.isCancelled\(\)\s*\?\s*"danger"\s*:\s*transfer\.isSuccessful\(\)\s*\?\s*"success"/,
    'cancelled or failed transfers must take precedence over the successful style',
  )
  assert.match(
    componentSource,
    /if \(!transfer\.isSuccessful\(\) && !transfer\.isCancelled\(\)\)\s*\{\s*transfer\.cancel\(\)/,
    'removing a 100% upload before its remote commit must still cancel it',
  )
  assert.match(
    componentSource,
    /this\.transfers\.some\(x => !x\.isSuccessful\(\) && !x\.isCancelled\(\)\)/,
    'bulk removal must treat an uncommitted 100% upload as active',
  )
})

test('upload consumers publish success only after their destination operation finishes', () => {
  const platformSource = readFileSync(resolve(repoRoot, 'tabby-core', 'src', 'api', 'platform.ts'), 'utf8')
  const sftpSource = readFileSync(resolve(repoRoot, 'tabby-ssh', 'src', 'session', 'sftp.ts'), 'utf8')
  const zmodemSource = readFileSync(resolve(repoRoot, 'tabby-terminal', 'src', 'features', 'zmodem.ts'), 'utf8')

  assert.match(
    platformSource,
    /async readAll[\s\S]*while \(true\)[\s\S]*this\.setCompleted\(true\)[\s\S]*return result/,
    'readAll should mark a local read successful only after reaching EOF',
  )
  assert.match(
    sftpSource,
    /await this\.rename\(tempPath, path\)\s*transfer\.setCompleted\(true\)\s*transfer\.close\(\)/,
    'the shared SFTP uploader should complete only after the remote rename succeeds',
  )
  assert.match(
    zmodemSource,
    /await xfer\.end\(\)[\s\S]*if \(!canceled\)\s*\{\s*transfer\.setCompleted\(true\)/,
    'ZMODEM should complete only after the receiver accepts the end of transfer',
  )
})

test('Shared message box component preserves keyboard defaults and long details', () => {
  const component = readFileSync(resolve(repoRoot, 'tabby-core', 'src', 'components', 'messageBoxModal.component.ts'), 'utf8')
  const template = readFileSync(resolve(repoRoot, 'tabby-core', 'src', 'components', 'messageBoxModal.component.pug'), 'utf8')
  const styles = readFileSync(resolve(repoRoot, 'tabby-core', 'src', 'components', 'messageBoxModal.component.scss'), 'utf8')
  const coreModule = readFileSync(resolve(repoRoot, 'tabby-core', 'src', 'index.ts'), 'utf8')
  const coreApi = readFileSync(resolve(repoRoot, 'tabby-core', 'src', 'api', 'index.ts'), 'utf8')

  assert.match(component, /@HostListener\(['"]document:keydown['"]/, 'message box must own Enter while it is open')
  assert.match(component, /event\.key !== 'Enter'/, 'non-Enter keys must not activate the default button')
  assert.match(component, /isValidButtonIndex\(this\.options\.defaultId\)/, 'Enter must only use a valid defaultId')
  assert.match(component, /querySelector<HTMLButtonElement>\(['"]button\[autofocus\]['"]\)\?\.focus\(\)/, 'missing default buttons must not throw during focus')
  assert.match(component, /this\.modalInstance\.dismiss\(\)/, 'the visible close button must dismiss into the cancel path')
  assert.match(template, /button\.btn-close/, 'the in-app message box must expose a visible close button')
  assert.match(template, /pre\.message-box-detail/, 'detail text must use a whitespace-preserving element')
  assert.match(styles, /white-space:\s*pre-wrap/, 'detail text must preserve line breaks')
  assert.match(styles, /max-height:/, 'long detail text must remain bounded')
  assert.match(styles, /overflow-y:\s*auto/, 'long detail text must scroll inside the modal')
  assert.match(coreModule, /declarations:\s*\[[^\]]*MessageBoxModalComponent/, 'CoreModule must declare the shared component')
  assert.match(coreModule, /exports:\s*\[[^\]]*MessageBoxModalComponent/, 'CoreModule must export the shared component')
  assert.match(coreApi, /export \{ MessageBoxModalComponent \} from '\.\.\/components\/messageBoxModal\.component'/, 'tabby-core must export the shared component type')
})

test('Web and Tauri platforms open the shared in-app message box', () => {
  const tauriHost = readFileSync(resolve(repoRoot, 'tabby-tauri', 'src', 'index.ts'), 'utf8')
  const webPlatform = readFileSync(resolve(repoRoot, 'tabby-web', 'src', 'platform.ts'), 'utf8')
  const webModule = readFileSync(resolve(repoRoot, 'tabby-web', 'src', 'index.ts'), 'utf8')
  const oldWebComponent = resolve(repoRoot, 'tabby-web', 'src', 'components', 'messageBoxModal.component.ts')
  const oldWebTemplate = resolve(repoRoot, 'tabby-web', 'src', 'components', 'messageBoxModal.component.pug')

  assert.match(tauriHost, /MessageBoxModalComponent[\s\S]*from 'tabby-core'/, 'Tauri must import the shared Core component')
  assert.match(tauriHost, /private ngbModal: NgbModal/, 'Tauri platform service must receive NgbModal')
  assert.match(tauriHost, /this\.ngbModal\.open\(MessageBoxModalComponent,\s*\{\s*backdrop:\s*'static',\s*keyboard:\s*true,?\s*\}\)/, 'Tauri must open a static in-app modal with Escape enabled')
  assert.match(tauriHost, /modal\.hidden\.subscribe\([\s\S]*previouslyFocusedElement\.focus\(\)/, 'Tauri must restore focus after the modal is fully hidden')
  assert.match(tauriHost, /return \{ response: options\.cancelId \?\? 1 \}/, 'Tauri dismissals must preserve the Web cancel contract')
  assert.doesNotMatch(tauriHost, /invoke<MessageBoxResult>\(['"]show_message_box['"]/, 'Tauri must not call a native message box command')
  assert.match(webPlatform, /MessageBoxModalComponent[\s\S]*from 'tabby-core'/, 'Web must import the shared Core component')
  assert.match(webPlatform, /backdrop:\s*'static',[\s\S]*keyboard:\s*true/, 'Web must keep the same modal dismissal behavior')
  assert.doesNotMatch(webModule, /messageBoxModal\.component/, 'WebModule must not declare a duplicate component')
  assert.equal(existsSync(oldWebComponent), false, 'the duplicate Web component must be deleted')
  assert.equal(existsSync(oldWebTemplate), false, 'the duplicate Web template must be deleted')
})

test('Rust host no longer exposes a native message box command', () => {
  const main = readFileSync(resolve(repoRoot, 'tauri-app', 'src-tauri', 'src', 'main.rs'), 'utf8')

  assert.doesNotMatch(main, /fn show_message_box\b/, 'Rust must not expose the obsolete native command')
  assert.doesNotMatch(main, /show_message_box,/, 'the obsolete command must not remain in the invoke handler')
  assert.doesNotMatch(main, /MessageBoxW|NativeMessageBoxOptions|NativeMessageBoxResult/, 'Win32 message box implementation must be removed')
  assert.match(main, /WindowsAndMessaging::SW_SHOWNORMAL/, 'ShellExecuteW must keep the remaining WindowsAndMessaging constant')
})
