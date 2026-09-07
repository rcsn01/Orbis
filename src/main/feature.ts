import { dialog } from 'electron'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { FeatureContext, MoirasiaFeature } from '@moirasia/desktop-shell/feature'
import { acquireFeatureSurface, type FeatureSurfaceHandle } from '@moirasia/desktop-shell/feature-surface-host'
import { OrbisController } from './controller'
import { WorkerScanExecution, type WorkerTransportFactory } from './scan-execution'
import { ScanFailureDiagnosticsStore } from './scan-failure-diagnostics'
import { registerIpc } from './ipc'
import { createOrbisSystemShell } from './system-shell'

export class OrbisFeature implements MoirasiaFeature {
  readonly id = 'orbis'
  #controller: OrbisController | undefined
  #surface: FeatureSurfaceHandle | undefined
  #disposeIpc: (() => void) | undefined

  async register(ctx: FeatureContext): Promise<void> {
    if (this.#controller) return
    if (ctx.id !== this.id || ctx.productId !== 'orbis') throw new Error('Invalid Orbis feature context')
    // Validation, the standalone window, its guards, appearance, load, show,
    // and teardown all live in the feature surface host.
    const surface = await acquireFeatureSurface(ctx)
    const dataDirectory = ctx.paths.dataDirectory!
    const workerPath = ctx.paths.workers!.scan!
    let controller: OrbisController | undefined
    let disposeIpc: (() => void) | undefined
    try {
      const diagnostics = new ScanFailureDiagnosticsStore(join(dataDirectory, 'indexes'))
      controller = new OrbisController(new WorkerScanExecution(createWorkerFactory(workerPath, ctx.paths.native?.metadata), { diagnostics }), {
        dataDirectory,
        ...(process.env.ORBIS_SCAN_ROOT ? { initialTarget: process.env.ORBIS_SCAN_ROOT } : {}),
        ...(surface.window ? { dialog: { showOpenDialog: (options) => dialog.showOpenDialog(surface.window!, options) } } : {}),
        shell: createOrbisSystemShell(() => surface.webContents)
      })
      // Publish the controller before initialization so dispose() can close an
      // index that is loading while the host is shutting down.
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

  async dispose(): Promise<void> {
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

  setActive(_active: boolean): void { /* The shell surface owns tab state. */ }

  async addLocation(): Promise<void> { await this.#controller?.addLocation() }
  async rescan(): Promise<void> { await this.#controller?.rescan() }
}

export const feature = new OrbisFeature()

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