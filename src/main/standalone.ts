import { app } from 'electron'
import { join } from 'node:path'
import type { FeatureContext } from '@moirasia/desktop-shell/feature'

/** Build the standalone host resources without making suite mode know app paths. */
export function standaloneContext(): FeatureContext {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  const worker = app.isPackaged
    ? join(process.resourcesPath, 'features', 'orbis', 'worker', 'scan-worker.mjs')
    : join(app.getAppPath(), 'worker-dist', 'scan-worker.mjs')
  const metadata = app.isPackaged
    ? join(process.resourcesPath, 'features', 'orbis', 'native', nativeAddonName())
    : join(app.getAppPath(), 'native', nativeAddonName())
  return {
    id: 'orbis',
    mode: 'standalone',
    productId: 'orbis',
    paths: {
      preloads: { main: join(import.meta.dirname, '../preload/index.cjs') },
      renderers: { main: rendererUrl ? `${rendererUrl}/index.html` : join(import.meta.dirname, '../renderer/index.html') },
      workers: { scan: worker },
      native: { metadata },
      dataDirectory: app.getPath('userData')
    }
  }
}

function nativeAddonName(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'darwin') return `orbis-metadata.darwin-${arch}.node`
  if (process.platform === 'win32') return 'orbis-metadata.win32-x64-msvc.node'
  return 'orbis-metadata.linux-x64-gnu.node'
}
