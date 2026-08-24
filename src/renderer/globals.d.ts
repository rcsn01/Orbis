import type { AppearanceApi } from '@moirasia/desktop-shell'
import type { OrbisApi } from '@moirasia/feature-orbis/shared/contracts'

declare global {
  interface Window {
    readonly orbis: OrbisApi
    readonly desktopShell: AppearanceApi
  }
}

export {}
