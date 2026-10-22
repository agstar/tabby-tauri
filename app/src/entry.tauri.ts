import 'zone.js'
import 'core-js/proposals/reflect-metadata'
import 'rxjs'

import './preload.scss'
import './tauri-branding.scss'
import './global.scss'
import './toastr.scss'

import { ApplicationRef, enableProdMode, NgModuleRef } from '@angular/core'
import { enableDebugTools } from '@angular/platform-browser'
import { platformBrowserDynamic } from '@angular/platform-browser-dynamic'

import { getRootModule } from './app.module'

interface TauriBootstrapData {
    platform?: string
    purpose?: string
    environment?: Record<string, string>
    os_release?: string
    app_version?: string
    winscp_path?: string | null
}

interface TauriPerfScenario {
    test_tabs: number
    source: string
}

interface TauriBundledPluginModules {
    plugins: any[]
    BOOTSTRAP_DATA: any
    ConfigService: any
    AppService: any
    TerminalService: any
}

if (!window.localStorage) {
    throw new Error('Tabby Tauri bootstrap requires localStorage for MVP config persistence')
}

if (!location.hash) {
    location.hash = ''
}

const isDev = typeof process !== 'undefined' && !!process.env.TABBY_DEV

if (!isDev) {
    enableProdMode()
}

function pluginModule (name: string, module: any, bootstrap?: unknown): any {
    const resolved = module.forRoot ? module.forRoot() : module
    resolved.pluginName = name
    if (bootstrap) {
        resolved.bootstrap = bootstrap
    }
    return resolved
}

async function loadBundledPluginModules (): Promise<TauriBundledPluginModules> {
    const [
        coreModule,
        settingsModule,
        terminalModule,
        localModule,
        sshModule,
        tauriModule,
    ] = await Promise.all([
        import(/* webpackChunkName: "tabby-core" */ 'tabby-core'),
        import(/* webpackChunkName: "tabby-settings" */ 'tabby-settings'),
        import(/* webpackChunkName: "tabby-terminal" */ 'tabby-terminal'),
        import(/* webpackChunkName: "tabby-local" */ 'tabby-local'),
        import(/* webpackChunkName: "tabby-ssh" */ 'tabby-ssh'),
        import(/* webpackChunkName: "tabby-tauri" */ 'tabby-tauri'),
    ])

    return {
        plugins: [
            pluginModule('core', coreModule.default, coreModule.bootstrap),
            pluginModule('settings', settingsModule.default),
            pluginModule('terminal', terminalModule.default),
            pluginModule('local', localModule.default),
            pluginModule('ssh', sshModule.default),
            pluginModule('tauri', tauriModule.default),
        ],
        BOOTSTRAP_DATA: coreModule.BOOTSTRAP_DATA,
        ConfigService: coreModule.ConfigService,
        AppService: coreModule.AppService,
        TerminalService: localModule.TerminalService,
    }
}

function describeError (error: unknown): string {
    if (error instanceof Error) {
        return error.stack ?? error.message
    }
    return String(error)
}

function installTauriAutomationHarness (): any {
    const harness = {
        tabs: [] as any[],
        outputs: [] as string[],
        clearOutput (index = 0): void {
            this.outputs[index] = ''
        },
        readOutput (index = 0): string {
            return this.outputs[index] ?? ''
        },
        sendInput (index = 0, input = ''): boolean {
            const tab = this.tabs[index]
            if (!tab || typeof tab.sendInput !== 'function') {
                return false
            }
            tab.sendInput(input)
            return true
        },
    }
    ;(window as any).__TABBY_TAURI_AUTOMATION__ = harness
    return harness
}

function instrumentTauriAutomationTab (tab: any, index: number, harness: any): void {
    if (!tab || tab.__tabbyTauriAutomationInstrumented || typeof tab.write !== 'function') {
        return
    }
    harness.tabs[index] = tab
    harness.outputs[index] = ''
    const originalWrite = tab.write.bind(tab)
    tab.write = async (data: string): Promise<void> => {
        const output = `${harness.outputs[index] ?? ''}${String(data)}`
        harness.outputs[index] = output.slice(-20000)
        await originalWrite(data)
    }
    tab.__tabbyTauriAutomationInstrumented = true
}

async function loadTauriPerfScenario (): Promise<TauriPerfScenario> {
    return await (window as any).__TAURI__?.core?.invoke('perf_scenario').catch(() => ({ test_tabs: 0, source: 'unavailable' })) as TauriPerfScenario
}

async function loadTauriBootstrapData (): Promise<any> {
    const tauriData = await (window as any).__TAURI__?.core?.invoke('bootstrap_data').catch(() => null) as TauriBootstrapData | null
    if (tauriData?.environment && typeof process !== 'undefined') {
        Object.assign(process.env, tauriData.environment)
        if (tauriData.os_release) {
            process.env.TABBY_OS_RELEASE = tauriData.os_release
        }
    }
    return {
        config: {
            hotkeys: {},
            appearance: {},
            terminal: {},
            ssh: {},
            profiles: [],
            recoverTabs: false,
            enableAnalytics: false,
            enableWelcomeTab: false,
            enableAutomaticUpdates: false,
            language: 'en-US',
        },
        executable: 'tabby-tauri',
        isMainWindow: true,
        windowID: 1,
        installedPlugins: [],
        userPluginsPath: '',
        ...tauriData,
    }
}

export async function bootstrapTauriTabby (): Promise<NgModuleRef<any>> {
    const bundled = await loadBundledPluginModules()
    const plugins = bundled.plugins

    window['pluginModules'] = plugins

    const bootstrapData = await loadTauriBootstrapData()
    bootstrapData.installedPlugins = plugins.map(module => ({
        name: module.pluginName,
        packageName: `tabby-${module.pluginName}`,
        isBuiltin: true,
        isLegacy: false,
        version: '0.0.0',
        description: 'Bundled Tauri MVP module',
        author: 'Tabby Developers',
    }))

    const module = getRootModule(plugins)
    const moduleRef = await platformBrowserDynamic([
        { provide: bundled.BOOTSTRAP_DATA, useValue: bootstrapData },
    ]).bootstrapModule(module)

    if (isDev) {
        const applicationRef = moduleRef.injector.get(ApplicationRef)
        const componentRef = applicationRef.components[0]
        enableDebugTools(componentRef)
    }

    const config = moduleRef.injector.get(bundled.ConfigService)
    await config.ready$.toPromise()
    config.store.recoverTabs = false
    config.store.enableAnalytics = false
    config.store.enableWelcomeTab = false
    config.store.enableAutomaticUpdates = false

    const perfScenario = await loadTauriPerfScenario()
    const app = moduleRef.injector.get(bundled.AppService)
    await app.ready$.toPromise()
    if (perfScenario.test_tabs > 0) {
        await Promise.all([...app.tabs].map(tab => app.closeTab(tab, false)))
    } else {
        await Promise.all(app.tabs
            .filter(tab => tab.constructor.name === 'WelcomeTabComponent')
            .map(tab => app.closeTab(tab, false)))
    }

    ;(window as any).__TABBY_TAURI_PERF__ = perfScenario
    document.body.dataset.tauriTestTabs = String(perfScenario.test_tabs)
    let openedTabs = 0
    const errors: string[] = []
    const automationHarness = perfScenario.test_tabs > 0 ? installTauriAutomationHarness() : null
    if (perfScenario.test_tabs > 0) {
        const terminal = moduleRef.injector.get(bundled.TerminalService)
        for (let i = 0; i < perfScenario.test_tabs; i++) {
            try {
                const tab = await terminal.openTab()
                if (tab) {
                    instrumentTauriAutomationTab(tab, openedTabs, automationHarness)
                    openedTabs++
                } else {
                    errors.push('TerminalService.openTab returned null')
                }
            } catch (error) {
                errors.push(describeError(error))
            }
        }
        document.body.dataset.tauriOpenedTabs = String(openedTabs)
    }
    await (window as any).__TAURI__?.core?.invoke('record_perf_automation', {
        report: {
            requested_tabs: perfScenario.test_tabs,
            opened_tabs: openedTabs,
            source: perfScenario.source,
            errors,
        },
    }).catch(() => null)

    return moduleRef
}

void bootstrapTauriTabby().catch(error => {
    console.error('Tauri Angular bootstrapping error:', error)
    void (window as any).__TAURI__?.core?.invoke('record_perf_automation', {
        report: {
            requested_tabs: 0,
            opened_tabs: 0,
            source: 'bootstrap-error',
            errors: [describeError(error)],
        },
    }).catch(() => null)
    document.body.textContent = `Tauri Angular bootstrapping error: ${error?.message ?? error}`
})
