import { app } from 'electron'
import { join } from 'node:path'

export interface OrbisResources {
  readonly preload: string
  readonly renderer: string
  readonly worker: string
  readonly nativeMetadata: string
  readonly dataDirectory: string
  readonly appearanceFile: string
}

/** Resolve resources owned by the standalone Orbis bundle. */
export function standaloneResources(): OrbisResources {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  const root = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return {
    preload: join(import.meta.dirname, '../preload/index.cjs'),
    renderer: rendererUrl ? `${rendererUrl}/index.html` : join(import.meta.dirname, '../renderer/index.html'),
    worker: app.isPackaged ? join(root, 'worker', 'scan-worker.mjs') : join(root, 'worker-dist', 'scan-worker.mjs'),
    nativeMetadata: join(root, 'native', nativeAddonFileName('orbis-metadata')),
    dataDirectory: app.getPath('userData'),
    appearanceFile: join(app.getPath('userData'), 'appearance.json')
  }
}

function nativeAddonFileName(base: string): string {
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'darwin') return `${base}.darwin-${architecture}.node`
  if (process.platform === 'win32') return `${base}.win32-x64-msvc.node`
  return `${base}.linux-x64-gnu.node`
}
