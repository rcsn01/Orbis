import { app } from 'electron'
import { join } from 'node:path'
import { artifactPath, featureCatalog, type FeatureContext } from '@moirasia/desktop-shell/feature'

/** Build the standalone host resources without making suite mode know app paths. */
export function standaloneContext(): FeatureContext {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  const entry = featureCatalog.get('orbis')
  const metadata = entry.artifacts.find((artifact) => artifact.name === 'metadata')!
  const scan = entry.artifacts.find((artifact) => artifact.name === 'scan')!
  const appDevRoot = app.getAppPath()
  const devPath = (artifact: typeof metadata): string => artifactPath(join(appDevRoot, artifact.buildOutput.replace('{configuration}', 'debug')), artifact)
  const packagedPath = (artifact: typeof metadata): string => artifactPath(join(process.resourcesPath, artifact.standaloneResource), artifact)
  return {
    id: 'orbis',
    mode: 'standalone',
    productId: 'orbis',
    paths: {
      preloads: { main: join(import.meta.dirname, '../preload/index.cjs') },
      renderers: { main: rendererUrl ? `${rendererUrl}/index.html` : join(import.meta.dirname, '../renderer/index.html') },
      workers: { scan: app.isPackaged ? packagedPath(scan) : devPath(scan) },
      native: { metadata: app.isPackaged ? packagedPath(metadata) : devPath(metadata) },
      dataDirectory: app.getPath('userData')
    }
  }
}