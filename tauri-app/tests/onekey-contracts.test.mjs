import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const repoRoot = resolve(import.meta.dirname, '..', '..', '..')

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function classSlice(source, className) {
  const start = source.indexOf(`class ${className}`)
  assert.notEqual(start, -1, `${className} must exist`)
  const nextClass = source.indexOf('\nexport class ', start + 1)
  return source.slice(start, nextClass === -1 ? undefined : nextClass)
}

function methodSlice(source, methodName, nextMethodName) {
  const start = source.indexOf(methodName)
  assert.notEqual(start, -1, `${methodName} must exist`)
  const end = nextMethodName ? source.indexOf(nextMethodName, start + methodName.length) : -1
  assert.notEqual(end, -1, `${nextMethodName} must exist after ${methodName}`)
  return source.slice(start, end)
}

test('OneKey metadata and secret targets stay separate from plaintext config storage', () => {
  const service = read('tabby/tabby-core/src/services/oneKey.service.ts')
  const defaults = read('tabby/tabby-core/src/configDefaults.yaml')

  assert.match(defaults, /oneKey:\s*\n\s+entries:\s*\[\]/)
  assert.match(service, /interface OneKeyEntry[\s\S]*hasPassword: boolean/)
  assert.match(service, /interface OneKeyPrivateKeyRef[\s\S]*id: string[\s\S]*hasPassphrase: boolean/)
  assert.match(service, /uuidv4\(\)/)
  assert.match(service, /onekey:\$\{entryId\}\/password/)
  assert.match(service, /onekey:\$\{entryId\}\/private-key:\$\{privateKeyId\}\/passphrase/)
  assert.doesNotMatch(service, /localStorage|window\.localStorage|password:\s*password|passphrase:\s*passphrase/)
})

test('Tauri OneKey secure provider uses native credentials without localStorage fallback', () => {
  const tauriIndex = read('tabby/tabby-tauri/src/index.ts')
  const tauriProviders = read('tabby/tauri-app/src/tauri-providers.ts')
  const indexClass = classSlice(tauriIndex, 'TauriOneKeySecretStorageProvider')
  const providerClass = classSlice(tauriProviders, 'TauriOneKeySecretStorageProvider')

  for (const source of [indexClass, providerClass]) {
    assert.match(source, /credential_get_password/)
    assert.match(source, /credential_set_password/)
    assert.match(source, /credential_delete_password/)
    assert.match(source, /tabby-onekey/)
    assert.doesNotMatch(source, /localStorage|saveLocalSecret|loadLocalSecret|fallback/i)
  }

  assert.match(tauriIndex, /\{ provide: OneKeySecretStorageProvider, useClass: TauriOneKeySecretStorageProvider \}/)
  assert.match(tauriProviders, /token: 'OneKeySecretStorageProvider'[\s\S]*replacement: 'TauriOneKeySecretStorageProvider'/)
})

test('SSH profiles can reference OneKey and Tauri resolves live password and key passphrase auth', () => {
  const interfaces = read('tabby/tabby-ssh/src/api/interfaces.ts')
  const profileUi = read('tabby/tabby-ssh/src/components/sshProfileSettings.component.pug')
  const tauriIndex = read('tabby/tabby-tauri/src/index.ts')

  assert.match(interfaces, /credentialMode\?: 'direct'\|'oneKey'/)
  assert.match(interfaces, /oneKeyId\?: string \| null/)
  assert.match(profileUi, /Credential source/)
  assert.match(profileUi, /profile\.options\.oneKeyId/)
  assert.match(profileUi, /isUsingOneKey\(\)/)

  assert.match(tauriIndex, /resolveOneKeyEntry/)
  assert.match(tauriIndex, /resolveOneKeyPassword/)
  assert.match(tauriIndex, /resolveOneKeyPrivateKeyCandidates/)
  assert.match(tauriIndex, /oneKey\.loadPrivateKeyPassphrase/)
  assert.match(tauriIndex, /passphrase: privateKeys\[0\]\?\.passphrase/)
  assert.match(tauriIndex, /private_keys: privateKeys/)
})

test('OneKey SSH auth honors explicit password mode before considering configured keys', () => {
  const tauriIndex = read('tabby/tabby-tauri/src/index.ts')
  const createRequest = methodSlice(tauriIndex, 'private async createConnectRequest', 'private async loadSavedPassword')
  const passwordBranch = createRequest.indexOf("options.auth === 'password'")
  const privateKeyBranch = createRequest.indexOf("options.auth === 'publicKey'")

  assert.ok(passwordBranch !== -1, 'password auth branch must exist')
  assert.ok(privateKeyBranch !== -1, 'private-key auth branch must exist')
  assert.ok(
    passwordBranch < privateKeyBranch || /options\.auth !== 'password' && privateKeyPath/.test(createRequest),
    'explicit password auth must not be bypassed by OneKey private-key candidates',
  )
})

test('duplicating non-OneKey SSH profiles copies the saved password into the new credential target', () => {
  const providerApi = read('tabby/tabby-core/src/api/profileProvider.ts')
  const profilesSettings = read('tabby/tabby-settings/src/components/profilesSettingsTab.component.ts')
  const sshProfiles = read('tabby/tabby-ssh/src/profiles.ts')

  assert.match(providerApi, /duplicateProfile \(source: P, destination: P\): void\|Promise<void> \{ \}/)
  assert.match(profilesSettings, /await this\.duplicateProfileSecrets\(base, result\)/)
  assert.match(profilesSettings, /provider\.duplicateProfile\(/)
  assert.match(profilesSettings, /getConfigProxyForProfile\(base\)/)
  assert.match(profilesSettings, /getConfigProxyForProfile\(result\)/)

  const duplicateProfile = methodSlice(sshProfiles, 'async duplicateProfile', 'private isOneKeyProfile')
  assert.match(duplicateProfile, /this\.isOneKeyProfile\(source\) \|\| this\.isOneKeyProfile\(destination\)/)
  assert.match(duplicateProfile, /this\.usesPasswordCredential\(source\)/)
  assert.match(duplicateProfile, /this\.passwordStorage\.loadPassword\(source\)/)
  assert.match(duplicateProfile, /this\.passwordStorage\.savePassword\(destination, password\)/)
  assert.doesNotMatch(duplicateProfile, /options\.oneKeyId\s*=/)
})

test('terminal-wide OneKey prompt detection uses a non-blocking inline chooser and validates active session before send', () => {
  const middleware = read('tabby/tabby-terminal/src/middleware/oneKeyPromptDetection.ts')
  const promptService = read('tabby/tabby-terminal/src/services/oneKeyPrompt.service.ts')
  const terminalTab = read('tabby/tabby-terminal/src/api/baseTerminalTab.component.ts')

  assert.match(middleware, /extends SessionMiddleware/)
  assert.match(middleware, /password\b/)
  assert.match(middleware, /passphrase\b/)
  assert.match(middleware, /密码\|口令/)
  assert.match(middleware, /DEDUPE_COOLDOWN_MS/)
  assert.match(middleware, /expiresAt/)

  assert.match(terminalTab, /new OneKeyPromptDetectionMiddleware/)
  assert.match(terminalTab, /session\.middleware\.push\(detector\)/)
  assert.match(terminalTab, /session\.middleware\.remove\(this\.oneKeyPromptDetector\.detector\)/)
  assert.match(terminalTab, /getOneKeyPromptAnchor/)
  assert.match(terminalTab, /xterm\.buffer\.active\.cursorX/)
  const sendInput = methodSlice(terminalTab, 'sendInput (data:', 'async write')
  assert.match(sendInput, /this\.oneKeyPrompt\?\.handleTerminalInput\(this\)/)
  assert.ok(
    sendInput.indexOf('this.oneKeyPrompt?.handleTerminalInput(this)') < sendInput.indexOf('this.session?.feedFromTerminal'),
    'terminal input must invalidate any OneKey chooser before it reaches the session',
  )

  assert.doesNotMatch(promptService, /selector\.show|showMessageBox|confirmSend|SelectorService|PlatformService/)
  assert.match(promptService, /onekey-inline-menu/)
  assert.match(promptService, /target\.getOneKeyPromptAnchor/)
  assert.match(promptService, /await this\.waitForTerminalRender/)
  assert.ok(
    promptService.indexOf('await this.waitForTerminalRender') < promptService.indexOf('this.showInlineMenu'),
    'inline menu must wait for the terminal to render the detected password prompt before reading cursor position',
  )
  assert.doesNotMatch(promptService, /onekey-inline-menu-header|onekey-inline-menu-context|onekey-inline-menu-hint|Select OneKey or type manually|Typing enters the terminal|promptExcerpt.*textContent/)
  assert.match(promptService, /isMenuNavigationKey/)
  assert.match(promptService, /event\.key === 'ArrowDown'/)
  assert.match(promptService, /event\.key === 'Enter'/)
  assert.match(promptService, /event\.key === 'Escape'/)
  assert.match(promptService, /target\.focusTerminal\?\.\(\)/)
  assert.match(promptService, /handleTerminalInput \(target: OneKeyPromptSendTarget\): void/)
  assert.match(promptService, /this\.promptGeneration\+\+/)
  assert.match(promptService, /this\.activeMenu\?\.target === target/)
  assert.match(promptService, /target\.session === session/)
  assert.match(promptService, /session\.open/)
  assert.match(promptService, /target\.hasFocus/)
  assert.match(promptService, /target\.sendInput\(`\$\{secret\}\\r`\)/)
  assert.ok(
    promptService.lastIndexOf('this.isTargetStillValid') > promptService.indexOf('await this.loadSecretChoice'),
    'prompt target must be revalidated after loading the secret and immediately before send',
  )
  assert.doesNotMatch(promptService, /localStorage|console\.(log|debug|warn|error)/)
})
