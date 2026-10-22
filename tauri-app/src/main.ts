import { invoke } from '@tauri-apps/api/core'
import { bootstrapManifest } from './tauri-bootstrap'
import { tauriMvpProviderManifest } from './tauri-providers'
import './styles.css'

// Legacy synthetic probe only. The default Tauri dev/build path now serves the
// Angular Tabby runtime from dist/index.html; display parity checks must fail if
// this probe bundle is loaded by the main Tauri lane.

const app = document.querySelector<HTMLDivElement>('#app')

if (!app) {
  throw new Error('Missing #app root')
}

const appRoot = app

interface PerfScenario {
  test_tabs: number
  source: 'env' | 'argv' | 'none' | string
}

const defaultPerfScenario: PerfScenario = {
  test_tabs: 0,
  source: 'none',
}

async function loadPerfScenario(): Promise<PerfScenario> {
  try {
    return await invoke<PerfScenario>('perf_scenario')
  } catch {
    return defaultPerfScenario
  }
}

function renderSyntheticTabs(count: number): string {
  if (count <= 0) {
    return '<p class="test-tab-empty">No synthetic test tabs requested.</p>'
  }

  return `
    <div class="test-tab-grid" role="list">
      ${Array.from({ length: count }, (_, index) => {
        const tabNumber = index + 1
        return `
          <article class="test-tab" role="listitem" data-tab-index="${tabNumber}">
            <strong>Test tab ${tabNumber}</strong>
            <span>deterministic WebView2 memory probe panel</span>
          </article>
        `
      }).join('')}
    </div>
  `
}

function renderApp(perfScenario: PerfScenario): void {
  appRoot.innerHTML = `
  <section class="shell">
    <header>
      <span class="dot"></span>
      <strong>Tabby Tauri MVP Shell</strong>
    </header>
    <article>
      <h1>Windows-only Tauri host probe</h1>
      <p>This scaffold exists only to validate WebView2 shell memory before PTY/SSH backend work.</p>
      <dl>
        <dt>Bootstrap component</dt>
        <dd>${bootstrapManifest.bootstrapComponent}</dd>
        <dt>Curated modules</dt>
        <dd>${bootstrapManifest.modules.join(', ')}</dd>
        <dt>Excluded runtime</dt>
        <dd>legacy desktop runtime and dynamic plugin loaders</dd>
        <dt>MVP providers</dt>
        <dd>${tauriMvpProviderManifest.map(provider => `${provider.token}: ${provider.action}`).join(', ')}</dd>
        <dt>Performance scenario</dt>
        <dd>${perfScenario.test_tabs} synthetic tabs (${perfScenario.source})</dd>
      </dl>
    </article>
    <section class="test-tabs" data-test-tabs="${perfScenario.test_tabs}" aria-label="Synthetic test tabs">
      <h2>Scenario tab scaffold</h2>
      ${renderSyntheticTabs(perfScenario.test_tabs)}
    </section>
  </section>
`
}

void loadPerfScenario().then(renderApp)
