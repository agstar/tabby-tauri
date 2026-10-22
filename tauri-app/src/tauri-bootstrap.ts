export interface TauriBootstrapManifest {
  bootstrapComponent: string
  modules: string[]
  excludedModules: string[]
}

export const bootstrapManifest: TauriBootstrapManifest = {
  bootstrapComponent: 'TauriMvpBootstrapComponent',
  modules: [
    'tabby-core/contracts',
    'tabby-terminal/session-ui',
    'tabby-local/pty-contracts',
    'tabby-ssh/profile-ui-subset',
    'tabby-tauri/providers',
  ],
  excludedModules: [
    'tabby-electron',
    'tabby-plugin-manager',
    'serial',
    'updater',
    'cross-platform-shell-providers',
  ],
}
