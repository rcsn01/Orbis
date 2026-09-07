import { dialog } from 'electron'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { acquireStandaloneSurface, type StandaloneSurface } from '@moirasia/desktop-shell/standalone-surface'
import { OrbisController } from './controller'
import { WorkerScanExecution, type WorkerTransportFactory } from './scan-execution'
import { ScanFailureDiagnosticsStore } from './scan-failure-diagnostics'
import { registerIpc } from './ipc'
import { standaloneResources } from './standalone'
import { createOrbisSystemShell } from './system-shell'

export class OrbisApplication {
  #controller: OrbisController | undefined
  #surface: StandaloneSurface | undefined
  #disposeIpc: (() => void) | undefined

  async start(): Promise<void> {
    if (this.#controller) return
    const resources = standaloneResources()
    const surface = await acquireStandaloneSurface({
      productId: 'orbis',
      title: 'Orbis',
      width: 1280,
      height: 820,
      minWidth: 860,
      minHeight: 600,
      preload: resources.preload,
      renderer: resources.renderer,
      appearanceFile: resources.appearanceFile,
      defaultAppearance: 'system'
    })
    let controller: OrbisController | undefined
    let disposeIpc: (() => void) | undefined
    try {
      const diagnostics = new ScanFailureDiagnosticsStore(join(resources.dataDirectory, 'indexes'))
      controller = new OrbisController(new WorkerScanExecution(createWorkerFactory(resources.worker, resources.nativeMetadata), { diagnostics }), {
        dataDirectory: resources.dataDirectory,
        ...(process.env.ORBIS_SCAN_ROOT ? { initialTarget: process.env.ORBIS_SCAN_ROOT } : {}),
        dialog: { showOpenDialog: (options) => dialog.showOpenDialog(surface.window, options) },
        shell: createOrbisSystemShell(() => surface.webContents)
      })
      this.#controller = controller
      await controller.initialize()
      disposeIpc = registerIpc({ webContents: surface.webContents, controller })
      this.#surface = surface
      this.#disposeIpc = disposeIpc
      await surface.ready()
    } catch (error) {
      disposeIpc?.()
      await controller?.close().catch(() => undefined)
      surface.dispose()
      if (!controller || this.#controller === controller) this.#controller = undefined
      this.#surface = undefined
      this.#disposeIpc = undefined
      throw error
    }
  }

  async stop(): Promise<void> {
    const controller = this.#controller
    const surface = this.#surface
    const disposeIpc = this.#disposeIpc
    this.#controller = undefined
    this.#surface = undefined
    this.#disposeIpc = undefined
    disposeIpc?.()
    try { await controller?.close() } finally { surface?.dispose() }
  }

  activate(): void { this.#surface?.activate() }
  async addLocation(): Promise<void> { await this.#controller?.addLocation() }
  async rescan(): Promise<void> { await this.#controller?.rescan() }
}

export const application = new OrbisApplication()

function createWorkerFactory(workerPath: string, nativeAddonPath: string | undefined): WorkerTransportFactory {
  const requestedDelay = Number(process.env.ORBIS_E2E_RESUME_VALIDATION_DELAY_MS)
  const resumeValidationDelayMs = Number.isFinite(requestedDelay) && requestedDelay > 0
    ? Math.min(30_000, Math.ceil(requestedDelay))
    : undefined
  const workerData = {
    ...(nativeAddonPath ? { nativeAddonPath } : {}),
    ...(resumeValidationDelayMs ? { resumeValidationDelayMs } : {})
  }
  const hasWorkerData = nativeAddonPath !== undefined || resumeValidationDelayMs !== undefined
  return { create: () => hasWorkerData ? new Worker(workerPath, { workerData }) : new Worker(workerPath) }
}
