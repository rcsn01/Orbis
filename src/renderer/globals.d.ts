import type { AppearanceApi } from '@moirasia/desktop-shell'
import type { GitHubUpdatesApi } from '@moirasia/desktop-shell/app-updater'
import type { OrbisApi } from '../shared/contracts'

declare global {
  interface Window {
    readonly orbis: OrbisApi
    readonly desktopShell: AppearanceApi
    githubUpdates?: GitHubUpdatesApi
  }
}

export {}
